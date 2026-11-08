package web

// The HTTP MCP server: MintWiki's shared tool definitions (internal/
// tools) exposed as JSON-RPC 2.0 at POST /mcp for non-browser agents.
// Stateless, JSON responses only — no SSE in this milestone. Both the
// initialize handshake (current MCP clients) and server/discover (the
// stateless 2026 revision, which drops initialize) are answered, from
// the same payload, so clients across the spec transition can connect.
//
// Reads are token-free. The one write-shaped tool, propose_edit, runs
// the same token lane as POST /edit — the bearer edit token arrives on
// the /mcp request's Authorization header — and always lands as a
// proposal: the head moves only when the owner accepts.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/Mocker/mintwiki/internal/receipts"
	"github.com/Mocker/mintwiki/internal/tools"
)

const mcpServerVersion = "0.2.0"

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func (s *Server) executor() *tools.Executor {
	return &tools.Executor{Store: s.Store, Propose: s.mcpPropose}
}

// mcpPropose is the Executor's ProposeFunc: the token lane for
// propose_edit, sharing verifyEditToken/proposeWithClaims with /edit.
// Auth failures are receipted as rejections, like /edit rejections.
func (s *Server) mcpPropose(req tools.ProposeRequest, auth string) (string, error) {
	claims, _, reason := s.verifyEditToken(auth, req.Path)
	if reason != "" {
		e := receipts.Entry{Page: req.Path, Result: "rejected", Reason: reason}
		if claims != nil {
			e.Actor = claims.Actor
			e.TokenJTI = claims.ID
			e.Scope = claims.ScopeString()
		}
		if cur, err := s.Store.HeadVersion(req.Path); err == nil {
			e.BeforeVer, e.AfterVer = cur, cur
		}
		_ = s.Receipts.Append(e)
		return "", errors.New(reason)
	}
	propID, _, reason := s.proposeWithClaims(claims, req.Path, req.Content, req.ExpectedVersion)
	if reason != "" {
		return "", errors.New(reason)
	}
	return propID, nil
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	var req rpcRequest
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&req); err != nil {
		writeRPC(w, http.StatusBadRequest, rpcResponse{
			JSONRPC: "2.0",
			Error:   &rpcError{Code: -32700, Message: "parse error"},
		})
		return
	}
	// Notifications (no id) are accepted and never answered with a body.
	if len(req.ID) == 0 || string(req.ID) == "null" {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}

	switch req.Method {
	case "initialize", "server/discover":
		resp.Result = s.discoveryResult(req.Params)
	case "ping":
		resp.Result = map[string]any{}
	case "tools/list":
		resp.Result = map[string]any{"tools": tools.Definitions()}
	case "tools/call":
		resp.Result = s.mcpCallTool(req.Params, r.Header.Get("Authorization"))
	default:
		resp.Error = &rpcError{Code: -32601, Message: fmt.Sprintf("method not found: %s", req.Method)}
	}
	writeRPC(w, http.StatusOK, resp)
}

func writeRPC(w http.ResponseWriter, code int, resp rpcResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(resp)
}

// discoveryResult is the initialize / server/discover payload: the
// protocol version echoes the client's when one is named, capabilities
// advertise exactly the tools surface.
func (s *Server) discoveryResult(params json.RawMessage) map[string]any {
	version := "2024-11-05"
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	if len(params) > 0 {
		_ = json.Unmarshal(params, &p)
		if p.ProtocolVersion != "" {
			version = p.ProtocolVersion
		}
	}
	return map[string]any{
		"protocolVersion": version,
		"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
		"serverInfo":      map[string]any{"name": "mintwiki", "version": mcpServerVersion},
	}
}

type mcpCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// mcpCallTool runs one tools/call and frames the outcome the MCP way:
// a successful call carries its JSON result as a text content block; a
// failed call carries the error text with isError set (the call itself
// succeeded at the protocol level).
func (s *Server) mcpCallTool(params json.RawMessage, auth string) map[string]any {
	var p mcpCallParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return mcpErrorResult("invalid tools/call params")
		}
	}
	if p.Name == "" {
		return mcpErrorResult("tool name is required")
	}
	result, err := s.executor().Dispatch(p.Name, p.Arguments, auth)
	if err != nil {
		return mcpErrorResult(err.Error())
	}
	b, err := json.Marshal(result)
	if err != nil {
		return mcpErrorResult("result encoding failed")
	}
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": string(b)}},
		"isError": false,
	}
}

func mcpErrorResult(msg string) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": msg}},
		"isError": true,
	}
}
