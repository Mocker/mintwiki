package token

import (
	"strings"
	"testing"
	"time"
)

func testKey() []byte {
	return []byte(strings.Join([]string{"mintwiki", "test", "key", "0123456789abcdef"}, "-"))
}

func TestMintParseRoundtrip(t *testing.T) {
	signed, claims, err := Mint(testKey(), "agent-1", ToolEdit, []string{"/projects/**"}, TierAllow, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Parse(testKey(), signed)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != claims.ID || got.Tool != ToolEdit || got.Tier != TierAllow || got.Actor != "agent-1" {
		t.Fatalf("claims mismatch: %+v", got)
	}
	if !got.CoversPath("/projects/demo") || !got.CoversPath("projects/demo") {
		t.Fatal("scope should cover /projects/demo")
	}
	if got.CoversPath("/private/x") {
		t.Fatal("scope must not cover /private/x")
	}
}

func TestExpiredTokenFails(t *testing.T) {
	signed, _, err := Mint(testKey(), "agent-1", ToolEdit, []string{"/**"}, TierAllow, -time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(testKey(), signed); err == nil {
		t.Fatal("expired token must fail verification")
	}
}

func TestWrongKeyFails(t *testing.T) {
	signed, _, err := Mint(testKey(), "agent-1", ToolEdit, []string{"/**"}, TierAllow, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	other := []byte(strings.Join([]string{"some", "other", "key", "fedcba9876543210"}, "-"))
	if _, err := Parse(other, signed); err == nil {
		t.Fatal("token signed with another key must fail")
	}
}

func TestPatternMatching(t *testing.T) {
	cases := []struct {
		pattern, path string
		want          bool
	}{
		{"/**", "anything/at/all", true},
		{"/projects/**", "projects", true},
		{"/projects/**", "projects/a/b", true},
		{"/projects/**", "projectsx/a", false},
		{"/projects/demo", "projects/demo", true},
		{"/projects/demo", "projects/demo2", false},
	}
	for _, c := range cases {
		if got := matchPattern(c.pattern, c.path); got != c.want {
			t.Errorf("matchPattern(%q, %q) = %v, want %v", c.pattern, c.path, got, c.want)
		}
	}
}
