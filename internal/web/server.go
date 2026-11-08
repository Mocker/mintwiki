// Package web is MintWiki's minimal HTTP surface for Milestone 1:
// serve the statically built site (pages are Markdown files, built to
// HTML), and the token-gated edit endpoint. Reads are open (public wiki
// semantics) and are plain static files; every write runs the full token
// lane and triggers a rebuild of the static site.
package web

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Mocker/mintwiki/internal/policy"
	"github.com/Mocker/mintwiki/internal/receipts"
	"github.com/Mocker/mintwiki/internal/site"
	"github.com/Mocker/mintwiki/internal/store"
	"github.com/Mocker/mintwiki/internal/token"
)

type Server struct {
	Store    *store.Store
	Receipts *receipts.Log
	Key      []byte
	SiteDir  string
	Policy   policy.Policy
}

func New(st *store.Store, rl *receipts.Log, key []byte, siteDir string, pol policy.Policy) *Server {
	return &Server{Store: st, Receipts: rl, Key: key, SiteDir: siteDir, Policy: pol}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /edit", s.handleEdit)
	mux.HandleFunc("POST /v1/tokens", s.handleMint)
	mux.HandleFunc("GET /v1/tokens/{id}", s.handleMintPoll)
	mux.HandleFunc("GET /{$}", s.handleIndex)
	mux.HandleFunc("GET /{path...}", s.handlePage)
	return mux
}

// rebuild regenerates the static site from the store. The store is the
// source of truth; the site is a view, so a rebuild failure never fails a
// write that already landed — the next build (or `mintwiki build`) heals it.
func (s *Server) rebuild() {
	_, _ = site.Build(s.Store, s.SiteDir)
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	b, err := os.ReadFile(filepath.Join(s.SiteDir, "index.html"))
	if err != nil {
		s.rebuild()
		b, err = os.ReadFile(filepath.Join(s.SiteDir, "index.html"))
		if err != nil {
			http.Error(w, "site not built", http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(b)
}

func (s *Server) handlePage(w http.ResponseWriter, r *http.Request) {
	path, err := store.NormalizePath(r.PathValue("path"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	page, err := s.Store.GetPage(path)
	if errors.Is(err, store.ErrNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "store error", http.StatusInternalServerError)
		return
	}
	file := filepath.Join(s.SiteDir, filepath.FromSlash(path)+".html")
	b, err := os.ReadFile(file)
	if err != nil {
		// Built file missing (e.g. the wiki was edited while this server
		// was down): rebuild once and retry.
		s.rebuild()
		b, err = os.ReadFile(file)
		if err != nil {
			http.Error(w, "site not built", http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-MintWiki-Revision", page.RevID)
	_, _ = w.Write(b)
}

type editRequest struct {
	Path            string `json:"path"`
	Content         string `json:"content"`
	ExpectedVersion int64  `json:"expected_version"`
}

type editResponse struct {
	Status        string `json:"status"` // applied | proposed
	Revision      string `json:"revision,omitempty"`
	Version       int64  `json:"version,omitempty"`
	ProposalID    string `json:"proposal_id,omitempty"`
	Error         string `json:"error,omitempty"`
	CurrentVer    *int64 `json:"current_version,omitempty"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// handleEdit runs the write lane in the spec's verification order:
// signature/expiry (token parse) → registered jti → not revoked →
// scope covers path → tier handling → CAS write → receipt.
// Rejections are receipted too.
func (s *Server) handleEdit(w http.ResponseWriter, r *http.Request) {
	var req editRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, editResponse{Error: "bad JSON body"})
		return
	}
	path, err := store.NormalizePath(req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, editResponse{Error: "invalid page path"})
		return
	}

	reject := func(code int, claims *token.Claims, reason string) {
		e := receipts.Entry{Page: path, Result: "rejected", Reason: reason}
		if claims != nil {
			e.Actor = claims.Actor
			e.TokenJTI = claims.ID
			e.Scope = claims.ScopeString()
		}
		if cur, err := s.Store.HeadVersion(path); err == nil {
			e.BeforeVer, e.AfterVer = cur, cur
		}
		_ = s.Receipts.Append(e)
		writeJSON(w, code, editResponse{Error: reason})
	}

	// 1. Bearer token present, signature + expiry valid.
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		reject(http.StatusUnauthorized, nil, "missing bearer token")
		return
	}
	claims, err := token.Parse(s.Key, strings.TrimPrefix(auth, "Bearer "))
	if err != nil {
		reject(http.StatusUnauthorized, nil, "invalid or expired token")
		return
	}
	// 2. The jti must have been minted by this wiki (registered at mint).
	registered, err := s.Store.IsRegistered(claims.ID)
	if err != nil || !registered {
		reject(http.StatusUnauthorized, claims, "token not minted by this wiki")
		return
	}
	// 3. Revocation beats expiry: a revoked token dies now.
	revoked, err := s.Store.IsRevoked(claims.ID)
	if err != nil || revoked {
		reject(http.StatusUnauthorized, claims, "token revoked")
		return
	}
	// 4. Scope: the right tool, covering this path.
	if claims.Tool != token.ToolEdit || !claims.CoversPath(path) {
		reject(http.StatusForbidden, claims, "token scope does not cover this page")
		return
	}

	before, _ := s.Store.HeadVersion(path)

	// 5a. approve tier: land as a proposal; the head does not move.
	if claims.Tier == token.TierApprove {
		propID, err := s.Store.AddProposal(path, []byte(req.Content), req.ExpectedVersion, claims.ID)
		if errors.Is(err, store.ErrConflict) {
			reject(http.StatusConflict, claims, "head moved since the edit was based on it")
			return
		}
		if err != nil {
			reject(http.StatusInternalServerError, claims, "store error")
			return
		}
		_ = s.Receipts.Append(receipts.Entry{
			Actor: claims.Actor, TokenJTI: claims.ID, Scope: claims.ScopeString(),
			Page: path, Result: "proposed", ProposalID: propID, BeforeVer: before, AfterVer: before,
		})
		writeJSON(w, http.StatusAccepted, editResponse{Status: "proposed", ProposalID: propID})
		return
	}

	// 5b. allow tier: CAS write moves the head.
	revID, newVer, curVer, err := s.Store.PutPage(path, []byte(req.Content), req.ExpectedVersion, claims.Actor, claims.ID)
	if errors.Is(err, store.ErrConflict) {
		_ = s.Receipts.Append(receipts.Entry{
			Actor: claims.Actor, TokenJTI: claims.ID, Scope: claims.ScopeString(),
			Page: path, Result: "rejected", Reason: "head conflict", BeforeVer: curVer, AfterVer: curVer,
		})
		writeJSON(w, http.StatusConflict, editResponse{Error: "head conflict", CurrentVer: &curVer})
		return
	}
	if err != nil {
		reject(http.StatusInternalServerError, claims, "store error")
		return
	}
	_ = s.Receipts.Append(receipts.Entry{
		Actor: claims.Actor, TokenJTI: claims.ID, Scope: claims.ScopeString(),
		Page: path, Result: "applied", RevID: revID, BeforeVer: before, AfterVer: newVer,
	})
	s.rebuild()
	writeJSON(w, http.StatusOK, editResponse{Status: "applied", Revision: revID, Version: newVer})
}

type mintRequest struct {
	Tool       string   `json:"tool"`
	Paths      []string `json:"paths"`
	Tier       string   `json:"tier"`
	TTLSeconds int64    `json:"ttl_seconds"`
}

type mintResponse struct {
	Token     string `json:"token,omitempty"`
	JTI       string `json:"jti,omitempty"`
	ExpiresAt string `json:"expires_at,omitempty"`
	Status    string `json:"status,omitempty"` // pending_approval | pending | approved | denied | issued | expired
	RequestID string `json:"request_id,omitempty"`
	Error     string `json:"error,omitempty"`
}

// handleMint is the token exchange: a service presents its long-lived
// credential and receives a short-lived edit token. The gates, in order:
// credential known → service not revoked → requested scope within the
// service's ceiling → tier allowed for this service → TTL within both
// the service cap and wiki policy. Routine requests inside the ceiling
// are issued automatically — no human in the loop. Requests outside the
// envelope are not flatly denied: they escalate to the owner's approval
// queue as mint requests (202), because widening an envelope is the
// owner's decision, and a request is worthless until approved.
func (s *Server) handleMint(w http.ResponseWriter, r *http.Request) {
	deny := func(code int, svc *store.Service, scopeDesc, reason string) {
		e := receipts.Entry{Result: "mint_denied", Reason: reason, Scope: scopeDesc}
		if svc != nil {
			e.Actor = svc.Name
		}
		_ = s.Receipts.Append(e)
		writeJSON(w, code, mintResponse{Error: reason})
	}

	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		deny(http.StatusUnauthorized, nil, "", "missing service credential")
		return
	}
	svc, err := s.Store.GetServiceByHash(store.HashCredential(strings.TrimPrefix(auth, "Bearer ")))
	if errors.Is(err, store.ErrNotFound) {
		deny(http.StatusUnauthorized, nil, "", "unknown service credential")
		return
	}
	if err != nil {
		deny(http.StatusInternalServerError, nil, "", "store error")
		return
	}
	if svc.Revoked {
		deny(http.StatusUnauthorized, svc, "", "service credential revoked")
		return
	}

	var req mintRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		deny(http.StatusBadRequest, svc, "", "bad JSON body")
		return
	}
	if req.Tool == "" {
		req.Tool = token.ToolEdit
	}
	scopeDesc := req.Tool + ":" + strings.Join(req.Paths, ",")
	if req.Tool != token.ToolEdit {
		deny(http.StatusForbidden, svc, scopeDesc, "unknown tool")
		return
	}
	if req.Tier == "" {
		req.Tier = token.TierAllow
	}
	ttl := s.Policy.DefaultTTL()
	if req.TTLSeconds > 0 {
		ttl = time.Duration(req.TTLSeconds) * time.Second
	}

	// Envelope gates. A failure here is not an attack signal — it is a
	// service asking for more than its ceiling, which is the owner's
	// decision. Escalate: record a mint request and answer 202; the
	// service polls for the outcome (see handleMintPoll).
	escalation := ""
	switch {
	case len(req.Paths) == 0:
		deny(http.StatusBadRequest, svc, scopeDesc, "no paths requested")
		return
	case !token.WithinCeiling(svc.CeilingPaths, req.Paths):
		escalation = "requested paths exceed service ceiling"
	case !tierAllowed(svc, req.Tier):
		escalation = "tier not allowed for this service"
	case ttl > time.Duration(svc.MaxTTLSeconds)*time.Second:
		escalation = "ttl exceeds service cap"
	case s.Policy.CheckTTL(ttl) != nil:
		escalation = "ttl exceeds wiki policy"
	}
	if escalation != "" {
		if existing, err := s.Store.FindPendingMintRequest(svc.Name, req.Tool, req.Paths, req.Tier, int64(ttl.Seconds())); err == nil {
			writeJSON(w, http.StatusAccepted, mintResponse{Status: "pending_approval", RequestID: existing.ID})
			return
		}
		id, err := s.Store.CreateMintRequest(svc.Name, req.Tool, req.Paths, req.Tier, int64(ttl.Seconds()))
		if err != nil {
			deny(http.StatusInternalServerError, svc, scopeDesc, "store error")
			return
		}
		_ = s.Receipts.Append(receipts.Entry{
			Actor: svc.Name, Scope: scopeDesc, Result: "mint_requested", Reason: escalation, RequestID: id,
		})
		writeJSON(w, http.StatusAccepted, mintResponse{Status: "pending_approval", RequestID: id})
		return
	}

	signed, claims, err := token.Mint(s.Key, svc.Name, req.Tool, req.Paths, req.Tier, ttl)
	if err != nil {
		deny(http.StatusBadRequest, svc, scopeDesc, err.Error())
		return
	}
	if err := s.Store.RegisterToken(claims.ID, claims.ScopeString(), claims.Tier, claims.ExpiresAt.Time.Unix()); err != nil {
		deny(http.StatusInternalServerError, svc, scopeDesc, "store error")
		return
	}
	_ = s.Receipts.Append(receipts.Entry{
		Actor: svc.Name, TokenJTI: claims.ID, Scope: claims.ScopeString(), Result: "minted",
	})
	writeJSON(w, http.StatusOK, mintResponse{
		Token: signed, JTI: claims.ID,
		ExpiresAt: claims.ExpiresAt.Time.UTC().Format(time.RFC3339),
	})
}

func tierAllowed(svc *store.Service, tier string) bool {
	for _, t := range svc.Tiers {
		if t == tier {
			return true
		}
	}
	return false
}

// mintRequestMaxAge bounds how long a pending mint request stays alive.
const mintRequestMaxAge = 24 * time.Hour

// handleMintPoll is the pickup endpoint for escalated mint requests. The
// requesting service polls with its own credential (a request belonging
// to another service reads as not-found). The token is minted at pickup
// time — never stored — and delivered exactly once.
func (s *Server) handleMintPoll(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		writeJSON(w, http.StatusUnauthorized, mintResponse{Error: "missing service credential"})
		return
	}
	svc, err := s.Store.GetServiceByHash(store.HashCredential(strings.TrimPrefix(auth, "Bearer ")))
	if errors.Is(err, store.ErrNotFound) || (err == nil && svc.Revoked) {
		writeJSON(w, http.StatusUnauthorized, mintResponse{Error: "unknown service credential"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, mintResponse{Error: "store error"})
		return
	}
	mreq, err := s.Store.GetMintRequest(r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && mreq.Service != svc.Name) {
		writeJSON(w, http.StatusNotFound, mintResponse{Error: "no such mint request"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, mintResponse{Error: "store error"})
		return
	}

	switch mreq.Status {
	case "pending":
		if created, perr := time.Parse(time.RFC3339, mreq.CreatedAt); perr == nil && time.Since(created) > mintRequestMaxAge {
			_ = s.Store.SetMintRequestStatus(mreq.ID, "expired")
			writeJSON(w, http.StatusOK, mintResponse{Status: "expired", RequestID: mreq.ID})
			return
		}
		writeJSON(w, http.StatusOK, mintResponse{Status: "pending", RequestID: mreq.ID})
	case "denied", "issued", "expired":
		writeJSON(w, http.StatusOK, mintResponse{Status: mreq.Status, RequestID: mreq.ID})
	case "approved":
		// Mint at pickup: TTL counts from now, and nothing sensitive was
		// ever stored against the request.
		ttl := time.Duration(mreq.TTLSeconds) * time.Second
		signed, claims, err := token.Mint(s.Key, svc.Name, mreq.Tool, mreq.Paths, mreq.Tier, ttl)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, mintResponse{Error: "mint failed"})
			return
		}
		if err := s.Store.RegisterToken(claims.ID, claims.ScopeString(), claims.Tier, claims.ExpiresAt.Time.Unix()); err != nil {
			writeJSON(w, http.StatusInternalServerError, mintResponse{Error: "store error"})
			return
		}
		if err := s.Store.SetMintRequestStatus(mreq.ID, "issued"); err != nil {
			writeJSON(w, http.StatusInternalServerError, mintResponse{Error: "store error"})
			return
		}
		_ = s.Receipts.Append(receipts.Entry{
			Actor: svc.Name, TokenJTI: claims.ID, Scope: claims.ScopeString(), Result: "minted", RequestID: mreq.ID,
		})
		writeJSON(w, http.StatusOK, mintResponse{
			Status: "approved", Token: signed, JTI: claims.ID,
			ExpiresAt: claims.ExpiresAt.Time.UTC().Format(time.RFC3339), RequestID: mreq.ID,
		})
	default:
		writeJSON(w, http.StatusInternalServerError, mintResponse{Error: "unknown request status"})
	}
}
