package site

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mocker/mintwiki/internal/store"
)

func TestBuildStaticSite(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, _, _, err := st.PutPage("projects/demo", []byte("# Demo\n\nhello"), 0, "owner", "jti-1"); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "site")
	n, err := Build(st, out)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("built %d pages, want 1", n)
	}
	pageHTML, err := os.ReadFile(filepath.Join(out, "projects", "demo.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(pageHTML), "hello") || !strings.Contains(string(pageHTML), "revision ") {
		t.Fatalf("page html missing content/revision: %s", pageHTML)
	}
	idx, err := os.ReadFile(filepath.Join(out, "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(idx), "projects/demo") {
		t.Fatalf("index missing page link: %s", idx)
	}
	// The page also lives as a plain Markdown file in the store.
	md, err := os.ReadFile(st.PageFilePath("projects/demo"))
	if err != nil {
		t.Fatal(err)
	}
	if string(md) != "# Demo\n\nhello" {
		t.Fatalf("page .md mirror = %q", md)
	}
}
