package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mocker/mintwiki/internal/policy"
	"github.com/Mocker/mintwiki/internal/receipts"
	"github.com/Mocker/mintwiki/internal/store"
)

func testServer(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	rl, err := receipts.Open(filepath.Join(dir, "receipts.log"))
	if err != nil {
		t.Fatal(err)
	}
	key := []byte(strings.Join([]string{"mintwiki", "web", "test", "key", "0123456789"}, "-"))
	s := New(st, rl, key, filepath.Join(dir, "site"), policy.Default())
	cred := strings.Join([]string{"mwsvc", "test", "credential"}, "_")
	if err := st.RegisterService("testsvc", store.HashCredential(cred),
		[]string{"/projects/**"}, []string{"allow"}, 1800); err != nil {
		t.Fatal(err)
	}
	return s, cred
}

func mintReq(t *testing.T, s *Server, cred, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/v1/tokens", bytes.NewBufferString(body))
	r.Header.Set("Authorization", "Bearer "+cred)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, r)
	return rec
}

func TestTokenExchange(t *testing.T) {
	s, cred := testServer(t)

	// Bad credential: 401.
	if rec := mintReq(t, s, "mwsvc_wrong", `{"paths":["/projects/demo"]}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("bad credential: got %d", rec.Code)
	}
	// Above the ceiling: escalates to the owner queue (202), not a flat denial.
	if rec := mintReq(t, s, cred, `{"paths":["/private/**"]}`); rec.Code != http.StatusAccepted {
		t.Fatalf("above ceiling should escalate: got %d", rec.Code)
	}
	// Tier the service doesn't hold: also escalates.
	if rec := mintReq(t, s, cred, `{"paths":["/projects/demo"],"tier":"approve"}`); rec.Code != http.StatusAccepted {
		t.Fatalf("tier above ceiling should escalate: got %d", rec.Code)
	}
	// TTL above the service cap: also escalates.
	if rec := mintReq(t, s, cred, `{"paths":["/projects/demo"],"ttl_seconds":7200}`); rec.Code != http.StatusAccepted {
		t.Fatalf("ttl above cap should escalate: got %d", rec.Code)
	}
	// Inside the ceiling: issued, and the token edits.
	rec := mintReq(t, s, cred, `{"paths":["/projects/**"],"ttl_seconds":600}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("exchange: got %d body %s", rec.Code, rec.Body.String())
	}
	var mr mintResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &mr); err != nil || mr.Token == "" {
		t.Fatalf("mint response: err=%v body=%s", err, rec.Body.String())
	}
	edit := httptest.NewRequest(http.MethodPost, "/edit",
		bytes.NewBufferString(`{"path":"projects/demo","content":"# via exchange","expected_version":0}`))
	edit.Header.Set("Authorization", "Bearer "+mr.Token)
	erec := httptest.NewRecorder()
	s.Handler().ServeHTTP(erec, edit)
	if erec.Code != http.StatusOK {
		t.Fatalf("edit with exchanged token: got %d body %s", erec.Code, erec.Body.String())
	}
	// Revoking the service kills future exchanges.
	if err := s.Store.RevokeService("testsvc"); err != nil {
		t.Fatal(err)
	}
	if rec := mintReq(t, s, cred, `{"paths":["/projects/demo"]}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("revoked service: got %d", rec.Code)
	}
}

func pollReq(t *testing.T, s *Server, cred, id string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/v1/tokens/"+id, nil)
	r.Header.Set("Authorization", "Bearer "+cred)
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, r)
	return rec
}

func pollStatus(t *testing.T, rec *httptest.ResponseRecorder) mintResponse {
	t.Helper()
	var mr mintResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &mr); err != nil {
		t.Fatalf("poll body: %v (%s)", err, rec.Body.String())
	}
	return mr
}

func TestMintEscalation(t *testing.T) {
	s, cred := testServer(t)
	// A second service, to prove requests can't be harvested cross-service.
	other := strings.Join([]string{"mwsvc", "other", "credential"}, "_")
	if err := s.Store.RegisterService("othersvc", store.HashCredential(other),
		[]string{"/projects/**"}, []string{"allow"}, 1800); err != nil {
		t.Fatal(err)
	}

	// Above-ceiling request → 202 + request id; re-submitting dedupes.
	rec := mintReq(t, s, cred, `{"paths":["/private/**"],"ttl_seconds":600}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("escalation: got %d", rec.Code)
	}
	mr := pollStatus(t, rec)
	if mr.RequestID == "" || mr.Status != "pending_approval" {
		t.Fatalf("escalation response: %+v", mr)
	}
	rec2 := mintReq(t, s, cred, `{"paths":["/private/**"],"ttl_seconds":600}`)
	if mr2 := pollStatus(t, rec2); mr2.RequestID != mr.RequestID {
		t.Fatalf("re-submit should dedupe: %q vs %q", mr2.RequestID, mr.RequestID)
	}

	// Poll: another service gets 404; the owner service sees pending.
	if rec := pollReq(t, s, other, mr.RequestID); rec.Code != http.StatusNotFound {
		t.Fatalf("cross-service poll: got %d", rec.Code)
	}
	if st := pollStatus(t, pollReq(t, s, cred, mr.RequestID)); st.Status != "pending" {
		t.Fatalf("poll before decision: %+v", st)
	}

	// Owner approves → pickup mints the token, exactly once.
	if err := s.Store.DecideMintRequest(mr.RequestID, true); err != nil {
		t.Fatal(err)
	}
	got := pollStatus(t, pollReq(t, s, cred, mr.RequestID))
	if got.Status != "approved" || got.Token == "" {
		t.Fatalf("pickup: %+v", got)
	}
	if st := pollStatus(t, pollReq(t, s, cred, mr.RequestID)); st.Status != "issued" || st.Token != "" {
		t.Fatalf("second pickup must not re-serve the token: %+v", st)
	}
	// The approved token edits the out-of-ceiling page.
	edit := httptest.NewRequest(http.MethodPost, "/edit",
		bytes.NewBufferString(`{"path":"private/x","content":"# approved scope","expected_version":0}`))
	edit.Header.Set("Authorization", "Bearer "+got.Token)
	erec := httptest.NewRecorder()
	s.Handler().ServeHTTP(erec, edit)
	if erec.Code != http.StatusOK {
		t.Fatalf("edit with approved token: got %d body %s", erec.Code, erec.Body.String())
	}

	// Denied requests stay denied and yield no token.
	rec = mintReq(t, s, cred, `{"paths":["/secret/**"],"ttl_seconds":600}`)
	mr = pollStatus(t, rec)
	if err := s.Store.DecideMintRequest(mr.RequestID, false); err != nil {
		t.Fatal(err)
	}
	if st := pollStatus(t, pollReq(t, s, cred, mr.RequestID)); st.Status != "denied" || st.Token != "" {
		t.Fatalf("denied poll: %+v", st)
	}
}
