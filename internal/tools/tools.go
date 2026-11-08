// Package tools is MintWiki's single tool-definition set: the six agent
// operations, defined once — name, description, JSON Schema — with their
// server-side implementations for the read tools. Both agent surfaces
// are generated from these definitions: the HTTP MCP server's tools/list
// serves them verbatim, and the static site's webmcp.js (the WebMCP
// registration) is generated from them at build time. There is no second
// copy of a tool schema anywhere.
//
// Reads are token-free (public-wiki semantics). The one write-shaped
// tool, propose_edit, has no implementation here: writing must run the
// token lane, which lives with the web server. The server injects a
// ProposeFunc into the Executor; the tool definition lives here so both
// surfaces advertise it identically.
package tools

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/Mocker/mintwiki/internal/store"
)

// Definition is one tool's public contract.
type Definition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

func schema(s string) json.RawMessage { return json.RawMessage(s) }

// Definitions returns the six tools, in a stable order.
func Definitions() []Definition {
	return []Definition{
		{
			Name:        "get_page",
			Description: "Read a wiki page at its current head. Returns the page content plus the exact revision ID and version it was read at, so the caller can cite the revision and detect later movement with one comparison.",
			InputSchema: schema(`{"type":"object","properties":{"path":{"type":"string","description":"Wiki page path, e.g. projects/demo"}},"required":["path"]}`),
		},
		{
			Name:        "get_section",
			Description: "Read one Markdown section of a page: the named heading and everything under it, up to the next heading of the same or higher level. Heading match is case-insensitive; leading # characters in the heading argument are optional.",
			InputSchema: schema(`{"type":"object","properties":{"path":{"type":"string","description":"Wiki page path"},"heading":{"type":"string","description":"Heading text to extract"}},"required":["path","heading"]}`),
		},
		{
			Name:        "search",
			Description: "Search all pages for a case-insensitive substring, matching page content and paths. Returns matching pages with a snippet around the first content match.",
			InputSchema: schema(`{"type":"object","properties":{"query":{"type":"string","description":"Text to search for"},"limit":{"type":"integer","description":"Maximum results (default 20, cap 50)"}},"required":["query"]}`),
		},
		{
			Name:        "backlinks",
			Description: "List the pages that link to a page, via Markdown links or [[wiki links]]. Useful before renaming or restructuring a page.",
			InputSchema: schema(`{"type":"object","properties":{"path":{"type":"string","description":"Wiki page path to find inbound links for"}},"required":["path"]}`),
		},
		{
			Name:        "recent_changes",
			Description: "List the newest page revisions across the wiki, newest first: revision ID, page path, parent revision, author, and creation time.",
			InputSchema: schema(`{"type":"object","properties":{"limit":{"type":"integer","description":"Maximum changes to return (default 20, cap 100)"}}}`),
		},
		{
			Name:        "propose_edit",
			Description: "Propose an edit to a page. Requires a MintWiki edit token (sent as the request's bearer credential) whose scope covers the page; the proposal lands in the owner's queue and the page head does not move until the owner accepts it. expected_version is the head version the edit is based on — a stale base is rejected as a conflict.",
			InputSchema: schema(`{"type":"object","properties":{"path":{"type":"string","description":"Wiki page path"},"content":{"type":"string","description":"Full replacement Markdown content for the page"},"expected_version":{"type":"integer","description":"Head version the edit is based on (0 for a new page)"}},"required":["path","content","expected_version"]}`),
		},
	}
}

// DefinitionJSON is the shared definitions as one JSON array — what
// `mintwiki tools` prints and what webmcp.js embeds.
func DefinitionJSON() ([]byte, error) {
	return json.Marshal(Definitions())
}

// ProposeRequest is a propose_edit call, handed to the injected
// ProposeFunc.
type ProposeRequest struct {
	Path            string
	Content         string
	ExpectedVersion int64
}

// ProposeFunc runs the token lane for a proposal. auth is the raw
// Authorization header value from the tool-call request ("" if none).
// It returns a proposal ID, or an error whose text is safe to show the
// caller.
type ProposeFunc func(req ProposeRequest, auth string) (string, error)

// Executor dispatches tool calls against a store.
type Executor struct {
	Store   *store.Store
	Propose ProposeFunc // injected by the server; nil = propose_edit unavailable
}

// Errors whose text is returned to tool callers.
var (
	ErrInvalidArgs = errors.New("invalid arguments")
	ErrUnknownTool = errors.New("unknown tool")
)

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidArgs, fmt.Sprintf(format, args...))
}

// Dispatch runs one tool call. args is the raw JSON arguments object;
// auth is the request's Authorization header (only propose_edit uses
// it). The result is a JSON-marshalable value.
func (e *Executor) Dispatch(name string, args json.RawMessage, auth string) (any, error) {
	switch name {
	case "get_page":
		var a struct {
			Path string `json:"path"`
		}
		if err := decodeArgs(args, &a); err != nil {
			return nil, err
		}
		return e.getPage(a.Path)
	case "get_section":
		var a struct {
			Path    string `json:"path"`
			Heading string `json:"heading"`
		}
		if err := decodeArgs(args, &a); err != nil {
			return nil, err
		}
		return e.getSection(a.Path, a.Heading)
	case "search":
		var a struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if err := decodeArgs(args, &a); err != nil {
			return nil, err
		}
		return e.search(a.Query, a.Limit)
	case "backlinks":
		var a struct {
			Path string `json:"path"`
		}
		if err := decodeArgs(args, &a); err != nil {
			return nil, err
		}
		return e.backlinks(a.Path)
	case "recent_changes":
		var a struct {
			Limit int `json:"limit"`
		}
		if len(args) > 0 {
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
		}
		return e.recentChanges(a.Limit)
	case "propose_edit":
		var a struct {
			Path            string `json:"path"`
			Content         string `json:"content"`
			ExpectedVersion *int64 `json:"expected_version"`
		}
		if err := decodeArgs(args, &a); err != nil {
			return nil, err
		}
		if a.ExpectedVersion == nil {
			return nil, invalid("expected_version is required")
		}
		path, err := normalizeToolPath(a.Path)
		if err != nil {
			return nil, err
		}
		if e.Propose == nil {
			return nil, errors.New("propose_edit is not available on this surface")
		}
		id, err := e.Propose(ProposeRequest{Path: path, Content: a.Content, ExpectedVersion: *a.ExpectedVersion}, auth)
		if err != nil {
			return nil, err
		}
		return map[string]any{"status": "proposed", "proposal_id": id, "path": path}, nil
	default:
		return nil, fmt.Errorf("%w: %s", ErrUnknownTool, name)
	}
}

func decodeArgs(args json.RawMessage, v any) error {
	if len(args) == 0 {
		return invalid("missing arguments object")
	}
	if err := json.Unmarshal(args, v); err != nil {
		return invalid("bad arguments: %v", err)
	}
	return nil
}

func normalizeToolPath(p string) (string, error) {
	path, err := store.NormalizePath(p)
	if err != nil {
		return "", invalid("bad page path %q", p)
	}
	return path, nil
}

type pageResult struct {
	Path     string `json:"path"`
	Revision string `json:"revision"`
	Version  int64  `json:"version"`
	Content  string `json:"content"`
}

func (e *Executor) getPage(rawPath string) (any, error) {
	path, err := normalizeToolPath(rawPath)
	if err != nil {
		return nil, err
	}
	page, err := e.Store.GetPage(path)
	if errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("page not found: %s", path)
	}
	if err != nil {
		return nil, err
	}
	return pageResult{Path: page.Path, Revision: page.RevID, Version: page.Version, Content: string(page.Content)}, nil
}

type sectionResult struct {
	Path     string `json:"path"`
	Revision string `json:"revision"`
	Version  int64  `json:"version"`
	Heading  string `json:"heading"`
	Level    int    `json:"level"`
	Content  string `json:"content"`
}

func (e *Executor) getSection(rawPath, heading string) (any, error) {
	path, err := normalizeToolPath(rawPath)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(heading) == "" {
		return nil, invalid("heading is required")
	}
	page, err := e.Store.GetPage(path)
	if errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("page not found: %s", path)
	}
	if err != nil {
		return nil, err
	}
	text, level, found := ExtractSection(string(page.Content), heading)
	if !found {
		return nil, fmt.Errorf("section not found: %q in %s", heading, path)
	}
	return sectionResult{
		Path: page.Path, Revision: page.RevID, Version: page.Version,
		Heading: canonicalHeading(heading), Level: level, Content: text,
	}, nil
}

func canonicalHeading(h string) string {
	return strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(h), "#"))
}

// headingLine parses a Markdown ATX heading line, returning its level
// and text. ok is false for non-heading lines.
func headingLine(line string) (level int, text string, ok bool) {
	trimmed := strings.TrimRight(line, " \t\r")
	n := 0
	for n < len(trimmed) && trimmed[n] == '#' {
		n++
	}
	if n == 0 || n > 6 || n >= len(trimmed) || trimmed[n] != ' ' {
		return 0, "", false
	}
	return n, strings.TrimSpace(trimmed[n:]), true
}

// ExtractSection returns the section under the named heading: the
// heading line plus everything up to (not including) the next heading
// of the same or higher level. Heading comparison is case-insensitive
// and ignores leading # characters in the query.
func ExtractSection(content, heading string) (text string, level int, found bool) {
	want := strings.ToLower(canonicalHeading(heading))
	lines := strings.Split(content, "\n")
	start, lvl := -1, 0
	for i, line := range lines {
		l, txt, ok := headingLine(line)
		if ok && strings.ToLower(txt) == want {
			start, lvl = i, l
			break
		}
	}
	if start < 0 {
		return "", 0, false
	}
	end := len(lines)
	for i := start + 1; i < len(lines); i++ {
		if l, _, ok := headingLine(lines[i]); ok && l <= lvl {
			end = i
			break
		}
	}
	return strings.TrimRight(strings.Join(lines[start:end], "\n"), "\n") + "\n", lvl, true
}

type searchHit struct {
	Path     string `json:"path"`
	Revision string `json:"revision"`
	Snippet  string `json:"snippet"`
}

func (e *Executor) search(query string, limit int) (any, error) {
	if strings.TrimSpace(query) == "" {
		return nil, invalid("query is required")
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	paths, err := e.Store.ListPages()
	if err != nil {
		return nil, err
	}
	q := strings.ToLower(query)
	hits := []searchHit{}
	for _, p := range paths {
		page, err := e.Store.GetPage(p)
		if err != nil {
			return nil, err
		}
		content := string(page.Content)
		idx := strings.Index(strings.ToLower(content), q)
		switch {
		case idx >= 0:
			hits = append(hits, searchHit{Path: p, Revision: page.RevID, Snippet: snippet(content, idx, len(query))})
		case strings.Contains(strings.ToLower(p), q):
			hits = append(hits, searchHit{Path: p, Revision: page.RevID, Snippet: p})
		}
		if len(hits) >= limit {
			break
		}
	}
	return map[string]any{"query": query, "results": hits}, nil
}

// snippet returns a window of content around a match, newlines folded.
func snippet(content string, idx, qlen int) string {
	start := idx - 60
	if start < 0 {
		start = 0
	}
	end := idx + qlen + 60
	if end > len(content) {
		end = len(content)
	}
	s := strings.ReplaceAll(content[start:end], "\n", " ")
	if start > 0 {
		s = "…" + s
	}
	if end < len(content) {
		s += "…"
	}
	return s
}

var (
	mdLinkRe   = regexp.MustCompile(`\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)
	wikiLinkRe = regexp.MustCompile(`\[\[([^\]|]+)(?:\|[^\]]*)?\]\]`)
)

// linkTargets extracts the normalized page paths a Markdown document
// links to. External URLs (containing "://") are skipped.
func linkTargets(content, fromPath string) map[string]bool {
	out := map[string]bool{}
	add := func(dest string) {
		dest = strings.TrimSpace(dest)
		if dest == "" || strings.Contains(dest, "://") || strings.HasPrefix(dest, "#") || strings.HasPrefix(dest, "mailto:") {
			return
		}
		if i := strings.Index(dest, "#"); i >= 0 {
			dest = dest[:i]
		}
		dest = strings.TrimSuffix(strings.TrimSuffix(dest, ".md"), ".html")
		if p, err := store.NormalizePath(dest); err == nil {
			out[p] = true
		}
		_ = fromPath // relative-link resolution is out of M2 scope; links are wiki-root paths
	}
	for _, m := range mdLinkRe.FindAllStringSubmatch(content, -1) {
		add(m[1])
	}
	for _, m := range wikiLinkRe.FindAllStringSubmatch(content, -1) {
		add(m[1])
	}
	return out
}

func (e *Executor) backlinks(rawPath string) (any, error) {
	path, err := normalizeToolPath(rawPath)
	if err != nil {
		return nil, err
	}
	if _, err := e.Store.GetPage(path); errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("page not found: %s", path)
	} else if err != nil {
		return nil, err
	}
	paths, err := e.Store.ListPages()
	if err != nil {
		return nil, err
	}
	found := []string{}
	for _, p := range paths {
		if p == path {
			continue
		}
		page, err := e.Store.GetPage(p)
		if err != nil {
			return nil, err
		}
		if linkTargets(string(page.Content), p)[path] {
			found = append(found, p)
		}
	}
	return map[string]any{"path": path, "backlinks": found}, nil
}

type changeResult struct {
	Revision       string `json:"revision"`
	Path           string `json:"path"`
	ParentRevision string `json:"parent_revision"`
	Author         string `json:"author"`
	CreatedAt      string `json:"created_at"`
}

func (e *Executor) recentChanges(limit int) (any, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	revs, err := e.Store.RecentChanges(limit)
	if err != nil {
		return nil, err
	}
	changes := []changeResult{}
	for _, r := range revs {
		changes = append(changes, changeResult{
			Revision: r.RevID, Path: r.PagePath, ParentRevision: r.ParentRev,
			Author: r.Author, CreatedAt: r.CreatedAt,
		})
	}
	return map[string]any{"changes": changes}, nil
}
