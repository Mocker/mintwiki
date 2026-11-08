package receipts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestChainVerifyAndTamper(t *testing.T) {
	path := filepath.Join(t.TempDir(), "receipts.log")
	l, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, page := range []string{"a", "b", "c"} {
		if err := l.Append(Entry{Actor: "owner", Page: page, Result: "applied"}); err != nil {
			t.Fatal(err)
		}
	}
	n, err := Verify(path)
	if err != nil || n != 3 {
		t.Fatalf("verify: n=%d err=%v", n, err)
	}
	// Tamper with the middle entry: the chain must break.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	lines[1] = strings.Replace(lines[1], `"page":"b"`, `"page":"forged"`, 1)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(path); err == nil {
		t.Fatal("tampered chain must fail verification")
	}
}
