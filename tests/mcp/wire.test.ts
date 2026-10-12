import { describe, expect, test } from "bun:test";
import { type JsonObject, eraOf, parseInbound, parseTool, parseToolResult } from "../../src/mcp/protocol";
import {
	buildHttpHeaders,
	buildRequest,
	encodeHeaderValue,
	extractParamHeaders,
	findReplyOrAnonymousError,
	judgeHttpProbe,
	judgeStdioProbe,
	parseReplyBody,
	pickVersion
} from "../../src/mcp/wire";
import { identity } from "./helpers";

describe("wire", () => {
	test("encodes header values per SEP-2243", () => {
		expect(encodeHeaderValue("us-west1")).toBe("us-west1");
		expect(encodeHeaderValue("Hello, 世界")).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
		expect(encodeHeaderValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
		expect(encodeHeaderValue("line1\nline2")).toBe("=?base64?bGluZTEKbGluZTI=?=");
		expect(encodeHeaderValue("=?base64?literal?=")).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
	});

	test("modern requests carry version, client info and empty capabilities in _meta", () => {
		const request = buildRequest("modern", 1, "tools/list", { cursor: "c" }, "2026-07-28", identity);
		expect(request.params).toEqual({
			cursor: "c",
			_meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientInfo": { name: "askmate", version: "9.9.9" },
				"io.modelcontextprotocol/clientCapabilities": {}
			}
		});
		expect(buildRequest("legacy", 2, "tools/list", {}, "2025-11-25", identity).params).toEqual({});
	});

	test("modern headers mirror method and name, legacy headers carry the session", () => {
		const modern = buildHttpHeaders({ era: "modern", version: "2026-07-28", method: "tools/call", name: "get_weather" });
		expect(modern["Mcp-Method"]).toBe("tools/call");
		expect(modern["Mcp-Name"]).toBe("get_weather");
		expect(modern["MCP-Protocol-Version"]).toBe("2026-07-28");
		const init = buildHttpHeaders({ era: "legacy", version: "2025-11-25", method: "initialize" });
		expect(init["MCP-Protocol-Version"]).toBeUndefined();
		const later = buildHttpHeaders({ era: "legacy", version: "2025-11-25", method: "tools/list", sessionId: "abc" });
		expect(later["Mcp-Session-Id"]).toBe("abc");
		expect(later["Mcp-Method"]).toBeUndefined();
	});

	test("x-mcp-header values are mirrored and bad annotations invalidate the tool", () => {
		const schema: JsonObject = { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" }, query: { type: "string" } } };
		expect(extractParamHeaders(schema, { region: "us-west1", query: "x" })).toEqual({ ok: true, headers: { "Mcp-Param-Region": "us-west1" } });
		expect(extractParamHeaders(schema, { query: "x" })).toEqual({ ok: true, headers: {} });
		const hidden: JsonObject = { type: "object", properties: { list: { type: "array", items: { type: "string", "x-mcp-header": "Bad" } } } };
		expect(extractParamHeaders(hidden, {}).ok).toBe(false);
		const number: JsonObject = { type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } };
		expect(extractParamHeaders(number, {}).ok).toBe(false);
	});

	test("parses JSON and SSE reply bodies alike", () => {
		const json = parseReplyBody("application/json", '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
		const sse = parseReplyBody("text/event-stream", 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
		expect(json).toEqual([{ kind: "result", id: 1, result: { ok: true } }]);
		expect(sse.map((message) => message.kind)).toEqual(["notification", "result"]);
		expect(parseReplyBody("application/json", "<html>")).toEqual([]);
	});

	test("an HTTP 400 proves a legacy server only when the body is not a modern error", () => {
		const ours = ["2026-07-28", "2025-11-25"];
		const legacy = judgeHttpProbe({ status: 400, headers: {}, text: "Bad Request" }, 1, ours);
		expect(legacy.kind).toBe("legacy");
		const modern = judgeHttpProbe({ status: 400, headers: {}, text: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32022, message: "x", data: { supported: ["2026-07-28"] } } }) }, 1, ours);
		expect(modern).toEqual({ kind: "retry-with", version: "2026-07-28" });
		expect(judgeHttpProbe({ status: 401, headers: { "www-authenticate": "Bearer" }, text: "" }, 1, ours)).toEqual({ kind: "auth", wwwAuthenticate: "Bearer" });
	});
});

describe("wire edge cases", () => {
	test("a modern error with a null id still counts as the answer to the probe", () => {
		const ours = ["2026-07-28", "2025-11-25"];
		const body = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32022, message: "x", data: { supported: ["2026-07-28"] } } });
		expect(judgeHttpProbe({ status: 400, headers: {}, text: body }, 7, ours)).toEqual({ kind: "retry-with", version: "2026-07-28" });
		expect(findReplyOrAnonymousError(parseReplyBody("application/json", body), 7)?.kind).toBe("error");
		expect(findReplyOrAnonymousError(parseReplyBody("application/json", '{"jsonrpc":"2.0","id":8,"result":{}}'), 7)).toBeNull();
	});

	test("a version-error that only lists legacy versions means legacy, and no overlap is a clear failure", () => {
		const ours = ["2026-07-28", "2025-11-25"];
		const legacyOnly = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32022, message: "x", data: { supported: ["2025-11-25"] } } });
		expect(judgeHttpProbe({ status: 400, headers: {}, text: legacyOnly }, 1, ours)).toEqual({ kind: "legacy" });
		const none = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32022, message: "x", data: { supported: ["2024-11-05"] } } });
		expect(judgeHttpProbe({ status: 400, headers: {}, text: none }, 1, ours).kind).toBe("failed");
		expect(pickVersion(["2025-03-26", "2025-11-25"], ours)).toBe("2025-11-25");
		expect(pickVersion([], ours)).toBeNull();
	});

	test("a modern 404 with method-not-found is reported, a 500 is a failure and a 2xx result is modern", () => {
		const ours = ["2026-07-28"];
		const missing = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } });
		expect(judgeHttpProbe({ status: 404, headers: {}, text: missing }, 1, ours).kind).toBe("failed");
		expect(judgeHttpProbe({ status: 500, headers: {}, text: "" }, 1, ours).kind).toBe("failed");
		const result = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { supportedVersions: ["2026-07-28"] } });
		expect(judgeHttpProbe({ status: 200, headers: { "content-type": "application/json" }, text: result }, 1, ours).kind).toBe("modern");
	});

	test("stdio probes: a result is modern, a version error picks a mutual version, any other error is legacy", () => {
		const ours = ["2026-07-28", "2025-11-25"];
		expect(judgeStdioProbe({ kind: "result", id: 1, result: {} }, ours).kind).toBe("modern");
		expect(judgeStdioProbe({ kind: "error", id: 1, error: { code: -32022, message: "x", data: { supported: ["2026-07-28"] } } }, ours)).toEqual({ kind: "retry-with", version: "2026-07-28" });
		expect(judgeStdioProbe({ kind: "error", id: 1, error: { code: -32601, message: "x" } }, ours).kind).toBe("legacy");
	});

	test("params headers refuse duplicates, invalid tokens and unsafe integers", () => {
		const duplicate: JsonObject = { type: "object", properties: { a: { type: "string", "x-mcp-header": "Same" }, b: { type: "string", "x-mcp-header": "same" } } };
		expect(extractParamHeaders(duplicate, {}).ok).toBe(false);
		const badToken: JsonObject = { type: "object", properties: { a: { type: "string", "x-mcp-header": "bad header" } } };
		expect(extractParamHeaders(badToken, {}).ok).toBe(false);
		const integer: JsonObject = { type: "object", properties: { n: { type: "integer", "x-mcp-header": "N" } } };
		expect(extractParamHeaders(integer, { n: 5 })).toEqual({ ok: true, headers: { "Mcp-Param-N": "5" } });
		expect(extractParamHeaders(integer, { n: 2 ** 60 }).ok).toBe(false);
	});
});

describe("protocol parsing", () => {
	test("era follows the version date", () => {
		expect(eraOf("2026-07-28")).toBe("modern");
		expect(eraOf("2027-01-01")).toBe("modern");
		expect(eraOf("2025-11-25")).toBe("legacy");
	});

	test("classifies inbound messages and rejects malformed ones", () => {
		expect(parseInbound({ jsonrpc: "2.0", id: 1, result: { a: 1 } })).toEqual({ kind: "result", id: 1, result: { a: 1 } });
		expect(parseInbound({ jsonrpc: "2.0", id: "x", error: { code: -1, message: "m" } })).toEqual({ kind: "error", id: "x", error: { code: -1, message: "m" } });
		expect(parseInbound({ jsonrpc: "2.0", method: "notifications/x" })).toEqual({ kind: "notification", method: "notifications/x", params: {} });
		expect(parseInbound({ jsonrpc: "2.0", id: 4, method: "ping" })).toEqual({ kind: "request", id: 4, method: "ping" });
		expect(parseInbound({ jsonrpc: "1.0", id: 1, result: {} })).toBeNull();
		expect(parseInbound({ jsonrpc: "2.0", id: 1, result: [] })).toBeNull();
		expect(parseInbound({ jsonrpc: "2.0", id: {}, error: { code: 1, message: "m" } })).toEqual({ kind: "error", id: null, error: { code: 1, message: "m" } });
		expect(parseInbound(null)).toBeNull();
	});

	test("tools need a name of 1 to 128 characters; annotations and schemas are normalised", () => {
		expect(parseTool({ description: "no name" })).toBeNull();
		expect(parseTool({ name: "" })).toBeNull();
		expect(parseTool({ name: "x".repeat(129) })).toBeNull();
		const parsed = parseTool({ name: "t", inputSchema: "oops", annotations: { readOnlyHint: true, destructiveHint: "yes" } });
		expect(parsed?.inputSchema).toEqual({ type: "object" });
		expect(parsed?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: undefined });
	});

	test("tool results keep text, describe binary content and flag errors", () => {
		const result = parseToolResult({
			isError: true,
			content: [
				{ type: "text", text: "boom" },
				{ type: "image", mimeType: "image/png", data: "AAAA" },
				{ type: "resource_link", uri: "file:///a" },
				{ type: "resource", resource: { uri: "file:///b", text: "body" } },
				{ type: "hologram" },
				"junk"
			]
		});
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{ type: "text", text: "boom" },
			{ type: "image", mimeType: "image/png", bytes: 3 },
			{ type: "resource_link", uri: "file:///a", name: "file:///a" },
			{ type: "resource", uri: "file:///b", text: "body" },
			{ type: "unknown", originalType: "hologram" },
			{ type: "unknown", originalType: "malformed" }
		]);
	});
});
