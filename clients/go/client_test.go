package mcpgateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func fake(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "Bearer k1" {
			w.WriteHeader(401)
			w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		switch {
		case r.URL.Path == "/api/v1/health":
			w.WriteHeader(207)
			w.Write([]byte(`{"status":"degraded","version":"4.7.0","servers":{"total":2,"online":1}}`))
		case r.URL.Path == "/api/v1/tools" && r.URL.Query().Get("format") == "openai":
			w.Write([]byte(`{"format":"openai","tools":[],"mapping":{"fs__read":{"server":"fs","tool":"read"}}}`))
		case r.URL.Path == "/api/v1/tools":
			if r.URL.Query().Get("server") != "fs" {
				t.Errorf("missing server filter: %s", r.URL.RawQuery)
			}
			w.Write([]byte(`{"tools":[{"name":"read","server":"fs"}]}`))
		case r.URL.Path == "/api/v1/tools/call":
			var b map[string]any
			json.NewDecoder(r.Body).Decode(&b)
			if b["tool"] == "danger" {
				w.Header().Set("Retry-After", "2")
				w.WriteHeader(403)
				w.Write([]byte(`{"code":-32003,"message":"denied by policy"}`))
				return
			}
			out, _ := json.Marshal(map[string]any{"result": map[string]any{"ok": true}, "server": b["server"], "tool": b["tool"], "durationMs": 1})
			w.Write(out)
		default:
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"message":"not found"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestHealthDegradedIsOK(t *testing.T) {
	c := New(fake(t).URL+"/", "k1")
	h, err := c.Health(context.Background())
	if err != nil || h.Status != "degraded" || h.Servers["total"] != 2 {
		t.Fatalf("got %+v %v", h, err)
	}
}

func TestToolsAndCall(t *testing.T) {
	c := New(fake(t).URL, "k1")
	ctx := context.Background()
	tools, err := c.ListTools(ctx, "fs", "")
	if err != nil || len(tools) != 1 || tools[0].Name != "read" {
		t.Fatalf("tools %+v %v", tools, err)
	}
	s, err := c.ToolSchemas(ctx, "openai")
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.CallLLMTool(ctx, s, "fs__read", `{"path":"/a"}`)
	if err != nil || res.Server != "fs" || res.Tool != "read" {
		t.Fatalf("call %+v %v", res, err)
	}
	if _, err := c.CallLLMTool(ctx, s, "nope", ""); err == nil {
		t.Fatal("expected unknown tool error")
	}
}

func TestPolicyError(t *testing.T) {
	c := New(fake(t).URL, "k1")
	_, err := c.CallTool(context.Background(), "danger", nil, "")
	var ge *Error
	if !errors.As(err, &ge) || ge.Status != 403 || !ge.IsPolicyError() || ge.Message != "denied by policy" || ge.RetryAfter.Seconds() != 2 {
		t.Fatalf("got %#v", err)
	}
}

func TestErrorMessagesAndAuth(t *testing.T) {
	srv := fake(t)
	_, err := New(srv.URL, "wrong").Servers(context.Background())
	var ge *Error
	if !errors.As(err, &ge) || ge.Status != 401 || ge.Message != "unauthorized" {
		t.Fatalf("got %#v", err)
	}
	c := New(srv.URL, "")
	c.Token = func() string { return "k1" }
	_, err = c.Servers(context.Background())
	if !errors.As(err, &ge) || ge.Status != 404 || ge.Message != "not found" {
		t.Fatalf("got %#v", err)
	}
}

func TestNetworkError(t *testing.T) {
	_, err := New("http://127.0.0.1:1", "k1").Health(context.Background())
	var ge *Error
	if !errors.As(err, &ge) || ge.Status != 0 {
		t.Fatalf("got %#v", err)
	}
}
