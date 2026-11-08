// Package site statically builds the wiki into plain HTML files: one
// index plus one .html per page, rendered from each page's head revision.
// Viewing MintWiki is reading static files — the build is regenerated
// whenever a head moves, and the whole site directory can be served by
// any static file server, not just MintWiki's own.
package site

import (
	"bytes"
	"fmt"
	"html"
	"os"
	"path/filepath"
	"strings"

	"github.com/yuin/goldmark"

	"github.com/Mocker/mintwiki/internal/store"
)

// Build renders every page in the store into outDir. Files are written
// atomically (temp + rename) so a concurrent reader never sees a partial
// page. Returns the number of pages built.
func Build(st *store.Store, outDir string) (int, error) {
	pages, err := st.ListPages()
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return 0, err
	}
	for _, path := range pages {
		page, err := st.GetPage(path)
		if err != nil {
			return 0, err
		}
		var buf bytes.Buffer
		if err := goldmark.Convert(page.Content, &buf); err != nil {
			return 0, err
		}
		doc := fmt.Sprintf("<!doctype html><title>%s — MintWiki</title><article>%s</article><footer><small>revision %s · version %d</small></footer>",
			html.EscapeString(path), buf.String(), page.RevID, page.Version)
		target := filepath.Join(outDir, filepath.FromSlash(path)+".html")
		if err := writeAtomic(target, []byte(doc)); err != nil {
			return 0, err
		}
	}
	var idx strings.Builder
	idx.WriteString("<!doctype html><title>MintWiki</title><h1>MintWiki</h1><ul>")
	for _, p := range pages {
		fmt.Fprintf(&idx, `<li><a href="/%s">%s</a></li>`, html.EscapeString(p), html.EscapeString(p))
	}
	idx.WriteString("</ul>")
	if err := writeAtomic(filepath.Join(outDir, "index.html"), []byte(idx.String())); err != nil {
		return 0, err
	}
	return len(pages), nil
}

func writeAtomic(target string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, target)
}
