// Package mcpgateway is a typed, dependency-free Go client for the mcp-gateway REST API (/api/v1).
package mcpgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Version of this client.
const Version = "4.7.0"

// Error is returned for non-2xx responses (Status = HTTP status) and for
// network or timeout failures (Status = 0).
type Error struct {
	Message    string
	Status     int
	Body       any
	RetryAfter time.Duration
}

func (e *Error) Error() string { return e.Message }

// Code is the gateway error code from the body (-32003 policy denied, …), or 0.
func (e *Error) Code() int {
	if m, ok := e.Body.(map[string]any); ok {
		if c, ok := m["code"].(float64); ok {
			return int(c)
		}
	}
	return 0
}

// IsPolicyError reports whether a gateway policy (rule, approval, output filter, plugin) refused the call.
func (e *Error) IsPolicyError() bool {
	switch e.Code() {
	case -32003, -32004, -32005, -32006:
		return true
	}
	return false
}

// Client talks to one gateway. Create it with New.
type Client struct {
	BaseURL string
	APIKey  string
	// Token returns a JWT per request; ignored when APIKey is set.
	Token   func() string
	Headers map[string]string
	HTTP    *http.Client
}

// New returns a client for baseURL (the gateway root, without /api/v1).
func New(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		APIKey:  apiKey,
		HTTP:    &http.Client{Timeout: 60 * time.Second},
	}
}

// Tool is one tool visible through the gateway.
type Tool struct {
	Name        string         `json:"name"`
	Server      string         `json:"server"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"inputSchema,omitempty"`
}

// CallToolResponse is the body of POST /tools/call.
type CallToolResponse struct {
	Result     json.RawMessage `json:"result"`
	Server     string          `json:"server"`
	Tool       string          `json:"tool"`
	DurationMs float64         `json:"durationMs"`
}

// LLMTarget maps an LLM tool name back to server + tool.
type LLMTarget struct {
	Server string `json:"server"`
	Tool   string `json:"tool"`
}

// ToolSchemas is the body of GET /tools?format=….
type ToolSchemas struct {
	Format  string               `json:"format"`
	Tools   []json.RawMessage    `json:"tools"`
	Mapping map[string]LLMTarget `json:"mapping"`
}

// Health is the body of GET /health.
type Health struct {
	Status  string         `json:"status"`
	Version string         `json:"version"`
	Uptime  float64        `json:"uptime"`
	Servers map[string]int `json:"servers"`
}

// Health calls GET /health (207 "degraded" is not an error).
func (c *Client) Health(ctx context.Context) (*Health, error) {
	var out Health
	return &out, c.do(ctx, "GET", "/api/v1/health", nil, &out, 207)
}

// Ready calls GET /health/ready; both 200 and 503 resolve, ready is status == "ready".
func (c *Client) Ready(ctx context.Context) (bool, map[string]any, error) {
	var out map[string]any
	err := c.do(ctx, "GET", "/api/v1/health/ready", nil, &out, 503)
	return err == nil && out["status"] == "ready", out, err
}

// Servers calls GET /servers.
func (c *Client) Servers(ctx context.Context) ([]map[string]any, error) {
	var out struct {
		Servers []map[string]any `json:"servers"`
	}
	err := c.do(ctx, "GET", "/api/v1/servers", nil, &out)
	return out.Servers, err
}

// ListTools calls GET /tools, optionally filtered by server and tag ("" = no filter).
func (c *Client) ListTools(ctx context.Context, server, tag string) ([]Tool, error) {
	var out struct {
		Tools []Tool `json:"tools"`
	}
	err := c.do(ctx, "GET", "/api/v1/tools"+query("server", server, "tag", tag), nil, &out)
	return out.Tools, err
}

// ToolSchemas calls GET /tools?format= (openai, openai-responses, anthropic).
func (c *Client) ToolSchemas(ctx context.Context, format string) (*ToolSchemas, error) {
	var out ToolSchemas
	return &out, c.do(ctx, "GET", "/api/v1/tools"+query("format", format), nil, &out)
}

// CallTool calls POST /tools/call; server may be "" for auto-routing.
func (c *Client) CallTool(ctx context.Context, tool string, args map[string]any, server string) (*CallToolResponse, error) {
	if args == nil {
		args = map[string]any{}
	}
	body := map[string]any{"tool": tool, "arguments": args}
	if server != "" {
		body["server"] = server
	}
	var out CallToolResponse
	return &out, c.do(ctx, "POST", "/api/v1/tools/call", body, &out)
}

// CallLLMTool executes a tool call an LLM produced from ToolSchemas (args is the raw JSON string).
func (c *Client) CallLLMTool(ctx context.Context, schemas *ToolSchemas, name, args string) (*CallToolResponse, error) {
	t, ok := schemas.Mapping[name]
	if !ok {
		return nil, &Error{Message: fmt.Sprintf("Unknown LLM tool name %q", name)}
	}
	parsed := map[string]any{}
	if args != "" {
		if err := json.Unmarshal([]byte(args), &parsed); err != nil {
			return nil, err
		}
	}
	return c.CallTool(ctx, t.Tool, parsed, t.Server)
}

// Approve / Deny decide a held tool call.
func (c *Client) Approve(ctx context.Context, id, reason string) error {
	return c.do(ctx, "POST", "/api/v1/approvals/"+url.PathEscape(id)+"/approve", map[string]any{"reason": reason}, nil)
}

func (c *Client) Deny(ctx context.Context, id, reason string) error {
	return c.do(ctx, "POST", "/api/v1/approvals/"+url.PathEscape(id)+"/deny", map[string]any{"reason": reason}, nil)
}

func (c *Client) do(ctx context.Context, method, path string, body, out any, ok ...int) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
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
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	res, err := hc.Do(req)
	if err != nil {
		return &Error{Message: "Network error: " + err.Error()}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return &Error{Message: "Network error: " + err.Error()}
	}
	good := res.StatusCode >= 200 && res.StatusCode < 300
	for _, s := range ok {
		good = good || res.StatusCode == s
	}
	if good {
		if out != nil && len(raw) > 0 {
			return json.Unmarshal(raw, out)
		}
		return nil
	}
	var parsed any
	if json.Unmarshal(raw, &parsed) != nil {
		parsed = string(raw)
	}
	e := &Error{Message: message(parsed, res.StatusCode), Status: res.StatusCode, Body: parsed}
	if ra := res.Header.Get("Retry-After"); ra != "" {
		if n, err := strconv.ParseFloat(ra, 64); err == nil {
			e.RetryAfter = time.Duration(n * float64(time.Second))
		}
	}
	return e
}

func message(parsed any, status int) string {
	if m, ok := parsed.(map[string]any); ok {
		if s, ok := m["message"].(string); ok && s != "" {
			return s
		}
		if em, ok := m["error"].(map[string]any); ok {
			if s, ok := em["message"].(string); ok && s != "" {
				return s
			}
		}
		if s, ok := m["error"].(string); ok && s != "" {
			return s
		}
	}
	return fmt.Sprintf("HTTP %d", status)
}

func query(kv ...string) string {
	v := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		if kv[i+1] != "" {
			v.Set(kv[i], kv[i+1])
		}
	}
	if len(v) == 0 {
		return ""
	}
	return "?" + v.Encode()
}
