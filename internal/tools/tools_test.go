package tools

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/Mocker/mintwiki/internal/store"
)

func testExecutor(t *testing.T) *Executor {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if _, _, _, err := st.PutPage("projects/demo", []byte("# Demo\n\n## Alpha\n\nalpha body with a banana.\n\n## Beta\n\nbeta body.\n"), 0, "owner", "jti-1"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := st.PutPage("projects/linker", []byte("# Linker\n\nSee [the demo](/projects/demo) and [[projects/demo]] again.\n"), 0, "owner", "jti-1"); err != nil {
		t.Fatal(err)
	}
	return &Executor{Store: st}
}

func call(t *testing.T, e *Executor, name, args string) map[string]any {
	t.Helper()
	res, err := e.Dispatch(name, json.RawMessage(args), "")
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	b, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestDefinitions(t *testing.T) {
	defs := Definitions()
	if len(defs) != 6 {
		t.Fatalf("want 6 tools, got %d", len(defs))
	}
	want := []string{"get_page", "get_section", "search", "backlinks", "recent_changes", "propose_edit"}
	for i, w := range want {
		if defs[i].Name != w {
			t.Fatalf("tool %d: want %s, got %s", i, w, defs[i].Name)
		}
		var s map[string]any
		if err := json.Unmarshal(defs[i].InputSchema, &s); err != nil {
			t.Fatalf("%s inputSchema is not valid JSON: %v", w, err)
		}
	}
}

func TestGetPageAndSection(t *testing.T) {
	e := testExecutor(t)
	page := call(t, e, "get_page", `{"path":"projects/demo"}`)
	if page["version"] != 1.0 || !strings.Contains(page["content"].(string), "banana") || page["revision"] == "" {
		t.Fatalf("get_page: %+v", page)
	}
	if _, err := e.Dispatch("get_page", json.RawMessage(`{"path":"nope"}`), ""); err == nil {
		t.Fatal("get_page on missing page should error")
	}
	sec := call(t, e, "get_section", `{"path":"projects/demo","heading":"alpha"}`)
	if !strings.Contains(sec["content"].(string), "banana") || strings.Contains(sec["content"].(string), "beta body") {
		t.Fatalf("get_section alpha: %+v", sec)
	}
	if sec["level"] != 2.0 {
		t.Fatalf("section level: %+v", sec)
	}
	sec = call(t, e, "get_section", `{"path":"projects/demo","heading":"## Beta"}`)
	if !strings.Contains(sec["content"].(string), "beta body") {
		t.Fatalf("get_section beta: %+v", sec)
	}
	if _, err := e.Dispatch("get_section", json.RawMessage(`{"path":"projects/demo","heading":"Gamma"}`), ""); err == nil {
		t.Fatal("get_section on missing heading should error")
	}
}

func TestSearchBacklinksRecent(t *testing.T) {
	e := testExecutor(t)
	res := call(t, e, "search", `{"query":"BANANA"}`)
	hits := res["results"].([]any)
	if len(hits) != 1 || hits[0].(map[string]any)["path"] != "projects/demo" {
		t.Fatalf("search: %+v", res)
	}
	bl := call(t, e, "backlinks", `{"path":"projects/demo"}`)
	links := bl["backlinks"].([]any)
	if len(links) != 1 || links[0] != "projects/linker" {
		t.Fatalf("backlinks (duplicate link forms must dedupe): %+v", bl)
	}
	rc := call(t, e, "recent_changes", `{"limit":1}`)
	changes := rc["changes"].([]any)
	if len(changes) != 1 || changes[0].(map[string]any)["path"] != "projects/linker" {
		t.Fatalf("recent_changes newest first: %+v", rc)
	}
}

func TestProposeDispatch(t *testing.T) {
	e := testExecutor(t)
	// No ProposeFunc injected: the tool reports itself unavailable.
	if _, err := e.Dispatch("propose_edit", json.RawMessage(`{"path":"projects/demo","content":"# x","expected_version":1}`), ""); err == nil {
		t.Fatal("propose without an injected lane should error")
	}
	var gotAuth string
	e.Propose = func(req ProposeRequest, auth string) (string, error) {
		gotAuth = auth
		if req.Path != "projects/demo" || req.ExpectedVersion != 1 {
			t.Fatalf("propose request: %+v", req)
		}
		return "prop-test-1", nil
	}
	res := call(t, e, "propose_edit", `{"path":"projects/demo","content":"# x","expected_version":1}`)
	// call() passes no auth; dispatch directly for the auth check.
	_ = res
	if _, err := e.Dispatch("propose_edit", json.RawMessage(`{"path":"projects/demo","content":"# x","expected_version":1}`), "Bearer abc"); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer abc" {
		t.Fatalf("auth not forwarded to the lane: %q", gotAuth)
	}
	if _, err := e.Dispatch("propose_edit", json.RawMessage(`{"path":"projects/demo","content":"# x"}`), ""); !errors.Is(err, ErrInvalidArgs) {
		t.Fatalf("missing expected_version should be invalid args, got %v", err)
	}
	if _, err := e.Dispatch("nope", json.RawMessage(`{}`), ""); !errors.Is(err, ErrUnknownTool) {
		t.Fatalf("unknown tool: got %v", err)
	}
}
