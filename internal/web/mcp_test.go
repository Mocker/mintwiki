package web

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Mocker/mintwiki/internal/token"
)

type rpcResp struct {
	Result map[string]any `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func rpc(t *testing.T, s *Server, auth, body string) (*httptest.ResponseRecorder, rpcResp) {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewBufferString(body))
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, r)
	var out rpcResp
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("rpc response not JSON: %v (%s)", err, rec.Body.String())
		}
	}
	return rec, out
}

func callResult(t *testing.T, resp rpcResp) (text string, isError bool) {
	t.Helper()
	content, ok := resp.Result["content"].([]any)
	if !ok || len(content) != 1 {
		t.Fatalf("tools/call result shape: %+v", resp.Result)
	}
	first := content[0].(map[string]any)
	return first["text"].(string), resp.Result["isError"] == true
}

func TestMCPDiscoveryAndList(t *testing.T) {
	s, _ := testServer(t)
	for _, method := range []string{"initialize", "server/discover"} {
		_, resp := rpc(t, s, "", `{"jsonrpc":"2.0","id":1,"method":"`+method+`","params":{"protocolVersion":"2025-06-18"}}`)
		if resp.Error != nil {
			t.Fatalf("%s: %+v", method, resp.Error)
		}
		if resp.Result["protocolVersion"] != "2025-06-18" {
			t.Fatalf("%s should echo protocol version: %+v", method, resp.Result)
		}
		info := resp.Result["serverInfo"].(map[string]any)
		if info["name"] != "mintwiki" {
			t.Fatalf("serverInfo: %+v", info)
		}
	}
	_, resp := rpc(t, s, "", `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	toolsList, ok := resp.Result["tools"].([]any)
	if !ok || len(toolsList) != 6 {
		t.Fatalf("tools/list: %+v", resp.Result)
	}
	names := map[string]bool{}
	for _, tl := range toolsList {
		names[tl.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"get_page", "get_section", "search", "backlinks", "recent_changes", "propose_edit"} {
		if !names[want] {
			t.Fatalf("tools/list missing %s", want)
		}
	}
	// Unknown method: protocol-level error.
	_, resp = rpc(t, s, "", `{"jsonrpc":"2.0","id":3,"method":"nope/nope"}`)
	if resp.Error == nil || resp.Error.Code != -32601 {
		t.Fatalf("unknown method: %+v", resp)
	}
	// Notifications: accepted, no body.
	rec, _ := rpc(t, s, "", `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if rec.Code != http.StatusAccepted || rec.Body.Len() != 0 {
		t.Fatalf("notification: code %d body %q", rec.Code, rec.Body.String())
	}
	// GET is refused.
	greq := httptest.NewRequest(http.MethodGet, "/mcp", nil)
	grec := httptest.NewRecorder()
	s.Handler().ServeHTTP(grec, greq)
	if grec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /mcp: got %d", grec.Code)
	}
}

func TestMCPToolsCall(t *testing.T) {
	s, _ := testServer(t)
	// Seed a page through the store.
	if _, _, _, err := s.Store.PutPage("projects/demo", []byte("# Demo\n\n## Alpha\n\nalpha banana text.\n"), 0, "owner", "jti-seed"); err != nil {
		t.Fatal(err)
	}

	_, resp := rpc(t, s, "", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_page","arguments":{"path":"projects/demo"}}}`)
	text, isErr := callResult(t, resp)
	if isErr || !strings.Contains(text, "banana") || !strings.Contains(text, `"version":1`) {
		t.Fatalf("get_page via MCP: isErr=%v text=%s", isErr, text)
	}
	_, resp = rpc(t, s, "", `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_section","arguments":{"path":"projects/demo","heading":"Alpha"}}}`)
	text, isErr = callResult(t, resp)
	if isErr || !strings.Contains(text, "banana") {
		t.Fatalf("get_section via MCP: isErr=%v text=%s", isErr, text)
	}
	_, resp = rpc(t, s, "", `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_page","arguments":{"path":"missing"}}}`)
	_, isErr = callResult(t, resp)
	if !isErr {
		t.Fatal("get_page on a missing page should be an isError result")
	}
}

func TestMCPProposeEditRunsTokenLane(t *testing.T) {
	s, _ := testServer(t)
	if _, _, _, err := s.Store.PutPage("projects/demo", []byte("# Demo v1\n"), 0, "owner", "jti-seed"); err != nil {
		t.Fatal(err)
	}
	callBody := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"propose_edit","arguments":{"path":"projects/demo","content":"# Demo v2 proposed","expected_version":1}}}`

	// No token: error result, head untouched.
	_, resp := rpc(t, s, "", callBody)
	if _, isErr := callResult(t, resp); !isErr {
		t.Fatal("propose without a token should be an error result")
	}
	// Unregistered token: also an error.
	bogus := strings.Join([]string{"not", "a", "jwt"}, ".")
	_, resp = rpc(t, s, "Bearer "+bogus, callBody)
	if _, isErr := callResult(t, resp); !isErr {
		t.Fatal("propose with a bogus token should be an error result")
	}
	// A real allow-tier token: proposal lands, head does not move.
	signed, claims, err := token.Mint(s.Key, "agent-mcp", token.ToolEdit, []string{"/projects/**"}, token.TierAllow, 600000000000)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Store.RegisterToken(claims.ID, claims.ScopeString(), claims.Tier, claims.ExpiresAt.Time.Unix()); err != nil {
		t.Fatal(err)
	}
	_, resp = rpc(t, s, "Bearer "+signed, callBody)
	text, isErr := callResult(t, resp)
	if isErr || !strings.Contains(text, "prop-") {
		t.Fatalf("propose with a token: isErr=%v text=%s", isErr, text)
	}
	if v, _ := s.Store.HeadVersion("projects/demo"); v != 1 {
		t.Fatalf("proposal moved the head to %d", v)
	}
	props, err := s.Store.ListProposals("pending")
	if err != nil || len(props) != 1 {
		t.Fatalf("pending proposals: %v %+v", err, props)
	}
	// Out-of-scope path with the same token: error.
	oos := `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"propose_edit","arguments":{"path":"private/x","content":"# no","expected_version":0}}}`
	_, resp = rpc(t, s, "Bearer "+signed, oos)
	if _, isErr := callResult(t, resp); !isErr {
		t.Fatal("out-of-scope propose should be an error result")
	}
}
