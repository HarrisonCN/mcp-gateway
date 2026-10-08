import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import MCPGateway

final class Recorder {
    var requests: [URLRequest] = []
}

func fake(_ rec: Recorder) -> GatewayClient.Transport {
    return { req in
        rec.requests.append(req)
        let path = req.url!.path
        let q = req.url!.query ?? ""
        func reply(_ status: Int, _ json: String, _ headers: [String: String] = [:]) -> (Data, HTTPURLResponse) {
            (Data(json.utf8), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!)
        }
        switch (req.httpMethod ?? "GET", path) {
        case ("GET", "/api/v1/health"): return reply(207, #"{"status":"degraded","version":"4.7.0"}"#)
        case ("GET", "/api/v1/health/ready"): return reply(503, #"{"status":"not_ready"}"#)
        case ("GET", "/api/v1/tools") where q.contains("format=openai"):
            return reply(200, #"{"format":"openai","tools":[],"mapping":{"fs__read":{"server":"fs","tool":"read"}}}"#)
        case ("GET", "/api/v1/tools"): return reply(200, #"{"tools":[{"name":"read","server":"fs"}]}"#)
        case ("POST", "/api/v1/tools/call"):
            let body = (try? JSONSerialization.jsonObject(with: req.httpBody ?? Data())) as? [String: Any] ?? [:]
            if body["tool"] as? String == "danger" {
                return reply(403, #"{"code":-32003,"message":"denied by policy"}"#, ["Retry-After": "2"])
            }
            let server = body["server"] as? String ?? "fs"
            return reply(200, #"{"result":{"content":[]},"server":""# + server + #"","tool":"read","durationMs":4}"#)
        default: return reply(404, #"{"error":{"message":"not found"}}"#)
        }
    }
}

final class GatewayClientTests: XCTestCase {
    func testHealthDegradedAndAuth() async throws {
        let rec = Recorder()
        let c = GatewayClient(baseURL: "http://gw.test/", apiKey: "k1", transport: fake(rec))
        let h = try await c.health()
        XCTAssertEqual(h["status"] as? String, "degraded")
        XCTAssertEqual(rec.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer k1")
        let ready = try await c.ready()
        XCTAssertFalse(ready)
    }

    func testToolsAndLLMCall() async throws {
        let rec = Recorder()
        let c = GatewayClient(baseURL: "http://gw.test", apiKey: "k1", transport: fake(rec))
        let tools = try await c.listTools(server: "fs")
        XCTAssertEqual(tools, [Tool(name: "read", server: "fs", description: nil)])
        XCTAssertEqual(rec.requests[0].url?.query, "server=fs")
        let s = try await c.toolSchemas(format: "openai")
        let res = try await c.callLLMTool(s.schemas, name: "fs__read", arguments: #"{"path":"/a"}"#)
        XCTAssertEqual(res.server, "fs")
        XCTAssertEqual(res.durationMs, 4)
    }

    func testPolicyError() async {
        let c = GatewayClient(baseURL: "http://gw.test", apiKey: "k1", transport: fake(Recorder()))
        do {
            _ = try await c.callTool("danger")
            XCTFail("expected error")
        } catch let e as GatewayError {
            XCTAssertEqual(e.status, 403)
            XCTAssertTrue(e.isPolicyError)
            XCTAssertEqual(e.message, "denied by policy")
            XCTAssertEqual(e.retryAfter, 2)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testNetworkAndNotFound() async {
        struct Boom: Error {}
        let broken = GatewayClient(baseURL: "http://gw.test", transport: { _ in throw Boom() })
        do { _ = try await broken.health(); XCTFail() } catch let e as GatewayError { XCTAssertEqual(e.status, 0) } catch { XCTFail() }
        let c = GatewayClient(baseURL: "http://gw.test", transport: fake(Recorder()))
        do { try await c.approve("a/1"); XCTFail() } catch let e as GatewayError {
            XCTAssertEqual(e.status, 404)
            XCTAssertEqual(e.message, "not found")
        } catch { XCTFail() }
    }
}
