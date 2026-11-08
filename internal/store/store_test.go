package store

import (
	"errors"
	"testing"
)

func openTest(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestCASWriteAndConflict(t *testing.T) {
	s := openTest(t)
	rev, ver, _, err := s.PutPage("projects/demo", []byte("# v1"), 0, "owner", "jti-1")
	if err != nil {
		t.Fatal(err)
	}
	if ver != 1 || rev == "" {
		t.Fatalf("got rev=%q ver=%d", rev, ver)
	}
	// Stale writer: based on version 0, but head is 1.
	_, _, cur, err := s.PutPage("projects/demo", []byte("# v2 stale"), 0, "agent", "jti-2")
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}
	if cur != 1 {
		t.Fatalf("conflict should report current version 1, got %d", cur)
	}
	// Fresh writer on the real head succeeds.
	_, ver, _, err = s.PutPage("projects/demo", []byte("# v2"), 1, "agent", "jti-2")
	if err != nil || ver != 2 {
		t.Fatalf("got ver=%d err=%v", ver, err)
	}
	page, err := s.GetPage("projects/demo")
	if err != nil {
		t.Fatal(err)
	}
	if string(page.Content) != "# v2" || page.Version != 2 {
		t.Fatalf("page = %q v%d", page.Content, page.Version)
	}
	// History is immutable: the v1 revision object still reads back.
	b, err := s.ReadRevision(rev)
	if err != nil || string(b) != "# v1" {
		t.Fatalf("old revision = %q err=%v", b, err)
	}
}

func TestProposalAccept(t *testing.T) {
	s := openTest(t)
	if _, _, _, err := s.PutPage("projects/demo", []byte("# v1"), 0, "owner", "jti-1"); err != nil {
		t.Fatal(err)
	}
	id, err := s.AddProposal("projects/demo", []byte("# v2 proposed"), 1, "jti-9")
	if err != nil {
		t.Fatal(err)
	}
	// Head must not move for a proposal.
	if v, _ := s.HeadVersion("projects/demo"); v != 1 {
		t.Fatalf("head moved to %d for a mere proposal", v)
	}
	newVer, _, err := s.AcceptProposal(id, "owner")
	if err != nil || newVer != 2 {
		t.Fatalf("accept: ver=%d err=%v", newVer, err)
	}
	page, _ := s.GetPage("projects/demo")
	if string(page.Content) != "# v2 proposed" {
		t.Fatalf("page = %q", page.Content)
	}
}

func TestTokenRegistry(t *testing.T) {
	s := openTest(t)
	if err := s.RegisterToken("jti-x", "edit_page:/a/**", "allow", 9999999999); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.IsRegistered("jti-x"); !ok {
		t.Fatal("jti-x should be registered")
	}
	if rev, _ := s.IsRevoked("jti-x"); rev {
		t.Fatal("jti-x should not be revoked yet")
	}
	if err := s.RevokeToken("jti-x"); err != nil {
		t.Fatal(err)
	}
	if rev, _ := s.IsRevoked("jti-x"); !rev {
		t.Fatal("jti-x should be revoked")
	}
}

func TestRecentChanges(t *testing.T) {
	s := openTest(t)
	if _, _, _, err := s.PutPage("a/one", []byte("# one"), 0, "owner", "jti-1"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := s.PutPage("a/two", []byte("# two"), 0, "agent", "jti-2"); err != nil {
		t.Fatal(err)
	}
	rev3, _, _, err := s.PutPage("a/one", []byte("# one v2"), 1, "agent", "jti-2")
	if err != nil {
		t.Fatal(err)
	}
	changes, err := s.RecentChanges(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 3 {
		t.Fatalf("want 3 changes, got %d", len(changes))
	}
	if changes[0].RevID != rev3 || changes[0].PagePath != "a/one" || changes[0].Author != "agent" {
		t.Fatalf("newest first: %+v", changes[0])
	}
	if changes[0].ParentRev == "" {
		t.Fatal("v2 revision should name its parent revision")
	}
	one, err := s.RecentChanges(1)
	if err != nil || len(one) != 1 || one[0].RevID != rev3 {
		t.Fatalf("limit 1: %+v err=%v", one, err)
	}
}

func TestNormalizePath(t *testing.T) {
	if p, err := NormalizePath("/projects/demo"); err != nil || p != "projects/demo" {
		t.Fatalf("got %q err=%v", p, err)
	}
	for _, bad := range []string{"", "/", "../etc", "a//b", "a/../b"} {
		if _, err := NormalizePath(bad); err == nil {
			t.Fatalf("path %q should be rejected", bad)
		}
	}
}
