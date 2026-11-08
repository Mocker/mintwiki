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
	// Above the ceiling: 403.
	if rec := mintReq(t, s, cred, `{"paths":["/private/**"]}`); rec.Code != http.StatusForbidden {
		t.Fatalf("above ceiling: got %d", rec.Code)
	}
	// Tier the service doesn't hold: 403.
	if rec := mintReq(t, s, cred, `{"paths":["/projects/demo"],"tier":"approve"}`); rec.Code != http.StatusForbidden {
		t.Fatalf("tier above ceiling: got %d", rec.Code)
	}
	// TTL above the service cap: 403.
	if rec := mintReq(t, s, cred, `{"paths":["/projects/demo"],"ttl_seconds":7200}`); rec.Code != http.StatusForbidden {
		t.Fatalf("ttl above cap: got %d", rec.Code)
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
