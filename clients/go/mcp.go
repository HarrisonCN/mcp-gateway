package mcpgateway

// Streaming tool calls (POST /api/v1/tools/stream) and MCP sessions (/mcp) — 5.7.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ProtocolVersion is the MCP revision MCPSession asks for.
const ProtocolVersion = "2025-11-25"

// Event is one server-sent event: Name is the `event:` field ("message" by default), Data the raw `data:` payload.
type Event struct {
	Name string
	Data json.RawMessage
}

// ParseSSE reads text/event-stream from r and calls fn for each event until EOF or fn returns an error.
func ParseSSE(r io.Reader, fn func(Event) error) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	name := "message"
	var data []string
	flush := func() error {
		if len(data) == 0 {
			name = "message"
			return nil
		}
		raw := strings.Join(data, "\n")
		ev := Event{Name: name}
		if json.Valid([]byte(raw)) {
			ev.Data = json.RawMessage(raw)
		} else {
			b, _ := json.Marshal(raw)
			ev.Data = b
		}
		name, data = "message", nil
		return fn(ev)
	}
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		switch {
		case line == "":
			if err := flush(); err != nil {
				return err
			}
		case strings.HasPrefix(line, ":"):
		case strings.HasPrefix(line, "event:"):
			name = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimLeft(line[5:], " "))
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return flush()
}

func (c *Client) newRequest(ctx context.Context, method, url string, body any, accept string) (*http.Request, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range c.Headers {
		req.Header.Set(k, v)
	}
	bearer := c.APIKey
	if bearer == "" && c.Token != nil {
		bearer = c.Token()
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	return req, nil
}

func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func errorFrom(res *http.Response) error {
	raw, _ := io.ReadAll(res.Body)
	var parsed any
	if json.Unmarshal(raw, &parsed) != nil {
		parsed = string(raw)
	}
	return &Error{Message: message(parsed, res.StatusCode), Status: res.StatusCode, Body: parsed}
}

// StreamTool calls a tool through POST /api/v1/tools/stream and hands each event (progress, partial, result,
// error, end) to fn as it arrives.
func (c *Client) StreamTool(ctx context.Context, tool string, args map[string]any, server string, fn func(Event) error) error {
	body := map[string]any{"tool": tool, "arguments": args}
	if args == nil {
		body["arguments"] = map[string]any{}
	}
	if server != "" {
		body["server"] = server
	}
	req, err := c.newRequest(ctx, http.MethodPost, c.BaseURL+"/api/v1/tools/stream", body, "text/event-stream")
	if err != nil {
		return err
	}
	res, err := c.httpClient().Do(req)
	if err != nil {
		return &Error{Message: "Network error: " + err.Error()}
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return errorFrom(res)
	}
	return ParseSSE(res.Body, fn)
}

// RPCError is a JSON-RPC error returned by /mcp.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("MCP error %d: %s", e.Code, e.Message) }

// MCPSession is a Streamable HTTP MCP session with the gateway's /mcp endpoint. Create it with Client.MCP.
type MCPSession struct {
	c               *Client
	URL             string
	SessionID       string
	ProtocolVersion string
	ServerInfo      map[string]any
	Capabilities    map[string]any
	id              int
}

// MCP opens a session (initialize + notifications/initialized). path defaults to "/mcp".
func (c *Client) MCP(ctx context.Context, path string) (*MCPSession, error) {
	if path == "" {
		path = "/mcp"
	}
	s := &MCPSession{c: c, URL: c.BaseURL + path}
	var init struct {
		ProtocolVersion string         `json:"protocolVersion"`
		ServerInfo      map[string]any `json:"serverInfo"`
		Capabilities    map[string]any `json:"capabilities"`
	}
	params := map[string]any{"protocolVersion": ProtocolVersion, "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "mcp-gateway-client-go", "version": Version}}
	if err := s.Request(ctx, "initialize", params, &init); err != nil {
		return nil, err
	}
	s.ProtocolVersion, s.ServerInfo, s.Capabilities = init.ProtocolVersion, init.ServerInfo, init.Capabilities
	if err := s.Notify(ctx, "notifications/initialized", nil); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *MCPSession) post(ctx context.Context, msg map[string]any) (json.RawMessage, error) {
	req, err := s.c.newRequest(ctx, http.MethodPost, s.URL, msg, "application/json, text/event-stream")
	if err != nil {
		return nil, err
	}
	if s.SessionID != "" {
		req.Header.Set("Mcp-Session-Id", s.SessionID)
	}
	if s.ProtocolVersion != "" {
		req.Header.Set("MCP-Protocol-Version", s.ProtocolVersion)
	}
	res, err := s.c.httpClient().Do(req)
	if err != nil {
		return nil, &Error{Message: "Network error: " + err.Error()}
	}
	defer res.Body.Close()
	if sid := res.Header.Get("Mcp-Session-Id"); sid != "" {
		s.SessionID = sid
	}
	if res.StatusCode == http.StatusAccepted {
		return nil, nil
	}
	if strings.Contains(res.Header.Get("Content-Type"), "text/event-stream") {
		var last json.RawMessage
		err := ParseSSE(res.Body, func(ev Event) error {
			var probe struct {
				ID json.RawMessage `json:"id"`
			}
			if json.Unmarshal(ev.Data, &probe) == nil && len(probe.ID) > 0 {
				last = ev.Data
			}
			return nil
		})
		return last, err
	}
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, &Error{Message: "Network error: " + err.Error()}
	}
	if res.StatusCode >= 400 {
		var env struct {
			Error *RPCError `json:"error"`
		}
		if json.Unmarshal(raw, &env) == nil && env.Error != nil {
			return nil, env.Error
		}
		var parsed any
		if json.Unmarshal(raw, &parsed) != nil {
			parsed = string(raw)
		}
		return nil, &Error{Message: message(parsed, res.StatusCode), Status: res.StatusCode, Body: parsed}
	}
	return raw, nil
}

// Request sends a JSON-RPC request and decodes its result into out (may be nil).
func (s *MCPSession) Request(ctx context.Context, method string, params, out any) error {
	s.id++
	msg := map[string]any{"jsonrpc": "2.0", "id": s.id, "method": method}
	if params != nil {
		msg["params"] = params
	}
	raw, err := s.post(ctx, msg)
	if err != nil {
		return err
	}
	var env struct {
		Result json.RawMessage `json:"result"`
		Error  *RPCError       `json:"error"`
	}
	if len(raw) == 0 {
		return &RPCError{Code: -32603, Message: "empty reply"}
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return err
	}
	if env.Error != nil {
		return env.Error
	}
	if out != nil && len(env.Result) > 0 {
		return json.Unmarshal(env.Result, out)
	}
	return nil
}

// Notify sends a JSON-RPC notification.
func (s *MCPSession) Notify(ctx context.Context, method string, params any) error {
	msg := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		msg["params"] = params
	}
	_, err := s.post(ctx, msg)
	return err
}

// MCPTool is a tool as listed by tools/list.
type MCPTool struct {
	Name        string         `json:"name"`
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"inputSchema,omitempty"`
}

// ListTools returns every tool, following nextCursor pagination.
func (s *MCPSession) ListTools(ctx context.Context) ([]MCPTool, error) {
	var all []MCPTool
	cursor := ""
	for {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var page struct {
			Tools      []MCPTool `json:"tools"`
			NextCursor string    `json:"nextCursor"`
		}
		if err := s.Request(ctx, "tools/list", params, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Tools...)
		if page.NextCursor == "" {
			return all, nil
		}
		cursor = page.NextCursor
	}
}

// CallTool calls tools/call and returns the raw MCP result.
func (s *MCPSession) CallTool(ctx context.Context, name string, args map[string]any) (json.RawMessage, error) {
	if args == nil {
		args = map[string]any{}
	}
	var out json.RawMessage
	err := s.Request(ctx, "tools/call", map[string]any{"name": name, "arguments": args}, &out)
	return out, err
}

// Ping sends an MCP ping.
func (s *MCPSession) Ping(ctx context.Context) error { return s.Request(ctx, "ping", nil, nil) }

// Close ends the session (DELETE); errors are ignored.
func (s *MCPSession) Close(ctx context.Context) {
	if s.SessionID == "" {
		return
	}
	if req, err := s.c.newRequest(ctx, http.MethodDelete, s.URL, nil, "application/json"); err == nil {
		req.Header.Set("Mcp-Session-Id", s.SessionID)
		if res, err := s.c.httpClient().Do(req); err == nil {
			res.Body.Close()
		}
	}
	s.SessionID = ""
}
