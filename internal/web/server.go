// Package web is MintWiki's minimal HTTP surface for Milestone 1:
// read a page (rendered, with its revision ID), list pages, and the
// token-gated edit endpoint. Reads are open (public wiki semantics);
// every write runs the full token lane.
package web

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"strings"

	"github.com/yuin/goldmark"

	"github.com/Mocker/mintwiki/internal/receipts"
	"github.com/Mocker/mintwiki/internal/store"
	"github.com/Mocker/mintwiki/internal/token"
)

type Server struct {
	Store    *store.Store
	Receipts *receipts.Log
	Key      []byte
}

func New(st *store.Store, rl *receipts.Log, key []byte) *Server {
	return &Server{Store: st, Receipts: rl, Key: key}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /edit", s.handleEdit)
	mux.HandleFunc("GET /{$}", s.handleIndex)
	mux.HandleFunc("GET /{path...}", s.handlePage)
	return mux
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	pages, err := s.Store.ListPages()
	if err != nil {
		http.Error(w, "store error", http.StatusInternalServerError)
		return
	}
	var b strings.Builder
	b.WriteString("<!doctype html><title>MintWiki</title><h1>MintWiki</h1><ul>")
	for _, p := range pages {
		fmt.Fprintf(&b, `<li><a href="/%s">%s</a></li>`, html.EscapeString(p), html.EscapeString(p))
	}
	b.WriteString("</ul>")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, b.String())
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
	var buf bytes.Buffer
	if err := goldmark.Convert(page.Content, &buf); err != nil {
		http.Error(w, "render error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-MintWiki-Revision", page.RevID)
	fmt.Fprintf(w, "<!doctype html><title>%s — MintWiki</title><article>%s</article><footer><small>revision %s · version %d</small></footer>",
		html.EscapeString(path), buf.String(), page.RevID, page.Version)
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
	writeJSON(w, http.StatusOK, editResponse{Status: "applied", Revision: revID, Version: newVer})
}
