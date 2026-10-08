package mcpgateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func mcpServer(t *testing.T, deleted *string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			*deleted = r.Header.Get("Mcp-Session-Id")
			w.WriteHeader(204)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		if r.URL.Path == "/api/v1/tools/stream" {
			if m["tool"] == "missing" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(404)
				fmt.Fprint(w, `{"error":"Not Found","message":"Unknown tool"}`)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, ": ping\n\nevent: progress\ndata: {\"progress\":1}\n\nevent: result\ndata: {\"result\":{\"ok\":true}}\n\nevent: end\ndata: {}\n\n")
			return
		}
		id, hasID := m["id"]
		if !hasID {
			w.WriteHeader(202)
			return
		}
		reply := func(v any) {
			w.Header().Set("Content-Type", "application/json")
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": v})
			w.Write(b)
		}
		switch m["method"] {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "s-1")
			reply(map[string]any{"protocolVersion": ProtocolVersion, "serverInfo": map[string]any{"name": "fake"}, "capabilities": map[string]any{}})
		case "tools/list":
			if p, _ := m["params"].(map[string]any); p != nil && p["cursor"] == "2" {
				reply(map[string]any{"tools": []any{map[string]any{"name": "b"}}})
			} else {
				reply(map[string]any{"tools": []any{map[string]any{"name": "a"}}, "nextCursor": "2"})
			}
		case "tools/call":
			if r.Header.Get("Mcp-Session-Id") != "s-1" || r.Header.Get("MCP-Protocol-Version") != ProtocolVersion {
				t.Errorf("missing session headers")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":%v,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"sse\"}]}}\n\n", id)
		case "ping":
			reply(map[string]any{})
		case "bad/http":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(400)
			fmt.Fprint(w, `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}`)
		default:
			w.Header().Set("Content-Type", "application/json")
			b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": "Method not found"}})
			w.Write(b)
		}
	}))
}

func TestParseSSE(t *testing.T) {
	var got []string
	err := ParseSSE(strings.NewReader("event: a\ndata: {\"x\":1}\n\ndata: plain\ndata: two"), func(e Event) error {
		got = append(got, e.Name+"="+string(e.Data))
		return nil
	})
	if err != nil || len(got) != 2 || got[0] != `a={"x":1}` || got[1] != `message="plain\ntwo"` {
		t.Fatalf("got %v %v", got, err)
	}
	stop := errors.New("stop")
	if err := ParseSSE(strings.NewReader("data: 1\n\ndata: 2\n\n"), func(Event) error { return stop }); err != stop {
		t.Fatalf("want stop, got %v", err)
	}
}

func TestStreamTool(t *testing.T) {
	var del string
	srv := mcpServer(t, &del)
	defer srv.Close()
	c := New(srv.URL, "k")
	var names []string
	if err := c.StreamTool(context.Background(), "slow", nil, "s", func(e Event) error { names = append(names, e.Name); return nil }); err != nil {
		t.Fatal(err)
	}
	if strings.Join(names, ",") != "progress,result,end" {
		t.Fatalf("events %v", names)
	}
	err := c.StreamTool(context.Background(), "missing", nil, "", func(Event) error { return nil })
	var ge *Error
	if !errors.As(err, &ge) || ge.Status != 404 {
		t.Fatalf("want 404, got %v", err)
	}
}

func TestMCPSession(t *testing.T) {
	var del string
	srv := mcpServer(t, &del)
	defer srv.Close()
	ctx := context.Background()
	s, err := New(srv.URL, "k").MCP(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if s.ProtocolVersion != ProtocolVersion || s.ServerInfo["name"] != "fake" || s.SessionID != "s-1" {
		t.Fatalf("bad session %+v", s)
	}
	tools, err := s.ListTools(ctx)
	if err != nil || len(tools) != 2 || tools[1].Name != "b" {
		t.Fatalf("tools %v %v", tools, err)
	}
	res, err := s.CallTool(ctx, "echo", nil)
	if err != nil || !strings.Contains(string(res), "sse") {
		t.Fatalf("call %s %v", res, err)
	}
	if err := s.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	var re *RPCError
	if err := s.Request(ctx, "nope", nil, nil); !errors.As(err, &re) || re.Code != -32601 || !strings.Contains(re.Error(), "Method not found") {
		t.Fatalf("want -32601, got %v", err)
	}
	if err := s.Request(ctx, "bad/http", nil, nil); !errors.As(err, &re) || re.Code != -32600 {
		t.Fatalf("want -32600, got %v", err)
	}
	s.Close(ctx)
	if del != "s-1" || s.SessionID != "" {
		t.Fatalf("not closed: %q", del)
	}
	if _, err := New("http://127.0.0.1:1", "").MCP(ctx, "/mcp"); err == nil {
		t.Fatal("want network error")
	}
}
