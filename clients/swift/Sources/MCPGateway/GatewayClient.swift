import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Error for non-2xx responses (`status` = HTTP status) and network failures (`status` = 0).
public struct GatewayError: Error, CustomStringConvertible {
    public let message: String
    public let status: Int
    /// Parsed JSON body, when there was one.
    public let body: Any?
    /// `Retry-After` in seconds for 429 / 503.
    public let retryAfter: Double?

    public var description: String { message }

    /// Gateway error code from the body (`-32003` policy denied, …).
    public var code: Int? { GatewayClient.number((body as? [String: Any])?["code"]).map { Int($0) } }

    /// True when a gateway policy (rule, approval, output filter, plugin) refused the call.
    public var isPolicyError: Bool { [-32003, -32004, -32005, -32006].contains(code ?? 0) }
}

public struct Tool: Decodable, Equatable {
    public let name: String
    public let server: String
    public let description: String?
}

public struct LLMTarget: Decodable, Equatable {
    public let server: String
    public let tool: String
}

public struct ToolSchemas: Decodable {
    public let mapping: [String: LLMTarget]
}

/// The body of `POST /tools/call`; `result` is the raw MCP result as JSON.
public struct CallToolResponse {
    public let server: String
    public let tool: String
    public let durationMs: Double
    public let result: [String: Any]
}

/// Typed client for the mcp-gateway REST API (`/api/v1`). Uses `URLSession` by default;
/// pass `transport` to plug in your own HTTP stack (or a test double).
public final class GatewayClient {
    public typealias Transport = (URLRequest) async throws -> (Data, HTTPURLResponse)

    public let baseURL: String
    public var apiKey: String?
    public var token: (() -> String?)?
    public var headers: [String: String]
    private let transport: Transport

    public init(baseURL: String, apiKey: String? = nil, headers: [String: String] = [:],
                timeout: TimeInterval = 60, transport: Transport? = nil) {
        var b = baseURL
        while b.hasSuffix("/") { b.removeLast() }
        self.baseURL = b
        self.apiKey = apiKey
        self.headers = headers
        if let transport = transport {
            self.transport = transport
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = timeout
            let session = URLSession(configuration: config)
            self.transport = { req in try await GatewayClient.send(session, req) }
        }
    }

    // MARK: Health

    /// `GET /health` (207 "degraded" is not an error).
    public func health() async throws -> [String: Any] {
        try await object("GET", "/api/v1/health", ok: [207])
    }

    /// `GET /health/ready` — true when the gateway is ready (503 resolves to false).
    public func ready() async throws -> Bool {
        let body = try await object("GET", "/api/v1/health/ready", ok: [503])
        return body["status"] as? String == "ready"
    }

    // MARK: Tools

    public func listTools(server: String? = nil, tag: String? = nil) async throws -> [Tool] {
        struct R: Decodable { let tools: [Tool] }
        let data = try await raw("GET", "/api/v1/tools" + Self.query(["server": server, "tag": tag]))
        return try JSONDecoder().decode(R.self, from: data).tools
    }

    /// `GET /tools?format=` — `openai`, `openai-responses` or `anthropic`; returns the raw JSON and the decoded mapping.
    public func toolSchemas(format: String) async throws -> (json: [String: Any], schemas: ToolSchemas) {
        let data = try await raw("GET", "/api/v1/tools" + Self.query(["format": format]))
        let json = (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return (json, try JSONDecoder().decode(ToolSchemas.self, from: data))
    }

    /// `POST /tools/call` (auto-routed unless `server` is given).
    public func callTool(_ tool: String, arguments: [String: Any] = [:], server: String? = nil) async throws -> CallToolResponse {
        var body: [String: Any] = ["tool": tool, "arguments": arguments]
        if let server = server { body["server"] = server }
        let o = try await object("POST", "/api/v1/tools/call", body: body)
        return CallToolResponse(server: o["server"] as? String ?? "", tool: o["tool"] as? String ?? tool,
                                durationMs: Self.number(o["durationMs"]) ?? 0,
                                result: o["result"] as? [String: Any] ?? [:])
    }

    /// Execute a tool call an LLM produced from `toolSchemas` (`arguments` is the raw JSON string).
    public func callLLMTool(_ schemas: ToolSchemas, name: String, arguments: String = "") async throws -> CallToolResponse {
        guard let t = schemas.mapping[name] else {
            throw GatewayError(message: "Unknown LLM tool name \"\(name)\"", status: 0, body: nil, retryAfter: nil)
        }
        var args: [String: Any] = [:]
        if !arguments.isEmpty, let d = arguments.data(using: .utf8) {
            args = (try JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
        }
        return try await callTool(t.tool, arguments: args, server: t.server)
    }

    // MARK: Approvals

    public func approve(_ id: String, reason: String? = nil) async throws {
        _ = try await raw("POST", "/api/v1/approvals/\(Self.seg(id))/approve", body: reason.map { ["reason": $0] } ?? [:])
    }

    public func deny(_ id: String, reason: String? = nil) async throws {
        _ = try await raw("POST", "/api/v1/approvals/\(Self.seg(id))/deny", body: reason.map { ["reason": $0] } ?? [:])
    }

    // MARK: Transport

    func object(_ method: String, _ path: String, body: [String: Any]? = nil, ok: Set<Int> = []) async throws -> [String: Any] {
        let data = try await raw(method, path, body: body, ok: ok)
        if data.isEmpty { return [:] }
        return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    func raw(_ method: String, _ path: String, body: [String: Any]? = nil, ok: Set<Int> = []) async throws -> Data {
        guard let url = URL(string: baseURL + path) else {
            throw GatewayError(message: "Invalid URL \(baseURL + path)", status: 0, body: nil, retryAfter: nil)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let bearer = apiKey ?? token?() { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if let body = body {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let res: HTTPURLResponse
        do {
            (data, res) = try await transport(req)
        } catch let e as GatewayError {
            throw e
        } catch {
            throw GatewayError(message: "Network error: \(error.localizedDescription)", status: 0, body: nil, retryAfter: nil)
        }
        if (200..<300).contains(res.statusCode) || ok.contains(res.statusCode) { return data }
        let parsed = try? JSONSerialization.jsonObject(with: data)
        let retry = res.allHeaderFields.first { ($0.key as? String)?.lowercased() == "retry-after" }
            .flatMap { ($0.value as? String).flatMap(Double.init) }
        throw GatewayError(message: Self.message(parsed, res.statusCode), status: res.statusCode, body: parsed, retryAfter: retry)
    }

    static func message(_ parsed: Any?, _ status: Int) -> String {
        if let o = parsed as? [String: Any] {
            if let m = o["message"] as? String, !m.isEmpty { return m }
            if let e = o["error"] as? [String: Any], let m = e["message"] as? String, !m.isEmpty { return m }
            if let e = o["error"] as? String, !e.isEmpty { return e }
        }
        return "HTTP \(status)"
    }

    /// JSON numbers arrive as NSNumber on Linux and as Int/Double on Darwin; accept all.
    static func number(_ v: Any?) -> Double? {
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let n = v as? NSNumber { return n.doubleValue }
        return nil
    }

    static func seg(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s
    }

    static func query(_ params: [String: String?]) -> String {
        let items = params.compactMap { k, v -> String? in
            guard let v = v, !v.isEmpty else { return nil }
            return "\(seg(k))=\(seg(v))"
        }.sorted()
        return items.isEmpty ? "" : "?" + items.joined(separator: "&")
    }

    static func send(_ session: URLSession, _ req: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await withCheckedThrowingContinuation { cont in
            session.dataTask(with: req) { data, res, err in
                if let err = err { return cont.resume(throwing: err) }
                guard let http = res as? HTTPURLResponse else {
                    return cont.resume(throwing: GatewayError(message: "Non-HTTP response", status: 0, body: nil, retryAfter: nil))
                }
                cont.resume(returning: (data ?? Data(), http))
            }.resume()
        }
    }
}
