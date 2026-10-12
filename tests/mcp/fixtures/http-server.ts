import type { HttpRequest, HttpResponse } from "../../../src/mcp/httpTransport";

export type HttpFixtureMode = "modern" | "legacy" | "protected" | "sse-only" | "endless";

export interface HttpFixture {
	url: string;
	/** Headers of every request, lower-cased names. */
	seen: Array<{ method: string; headers: Record<string, string>; body: unknown }>;
	stop(): void;
}

/**
 * A local Streamable HTTP MCP server on a random port.
 *  modern     answers server/discover; tools/call replies as a (buffered) SSE stream
 *  legacy     rejects server/discover with 400, mints a session on initialize and 404s without it
 *  protected  modern, but needs `Authorization: Bearer good`
 *  sse-only   a retired HTTP+SSE server: every POST gets 405
 *  endless    answers a tools/call with an SSE stream that never ends
 */
export function startHttpFixture(mode: HttpFixtureMode): HttpFixture {
	const seen: HttpFixture["seen"] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const body: unknown = request.method === "POST" ? await request.json() : null;
			const headers: Record<string, string> = {};
			request.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
			seen.push({ method: request.method, headers, body });
			const message = (body ?? {}) as { id?: number; method?: string; params?: { name?: string; arguments?: { text?: string } } };

			if (mode === "sse-only") {
				return new Response("", { status: 405 });
			}
			if (mode === "protected" && request.headers.get("authorization") !== "Bearer good") {
				return new Response("", { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource", scope="mcp:tools"' } });
			}
			if (request.method === "DELETE") {
				return new Response("", { status: 204 });
			}
			if (message.id === undefined) {
				return new Response(null, { status: 202 });
			}
			const rpc = (result: unknown): Response => Response.json({ jsonrpc: "2.0", id: message.id, result });

			if (mode === "legacy") {
				if (message.method === "server/discover") {
					return new Response("Bad Request", { status: 400 });
				}
				if (message.method === "initialize") {
					return new Response(
						JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "HttpLegacy", version: "1" } } }),
						{ headers: { "content-type": "application/json", "Mcp-Session-Id": "sess-xyz" } }
					);
				}
				if (request.headers.get("mcp-session-id") !== "sess-xyz") {
					return new Response("", { status: 404 });
				}
			}
			switch (message.method) {
				case "server/discover":
					return rpc({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "HttpModern", version: "2" } }, ttlMs: 1000 });
				case "tools/list":
					return rpc({
						...(mode === "legacy" ? {} : { resultType: "complete", ttlMs: 1000 }),
						tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string", "x-mcp-header": "Text" } } } }]
					});
				case "tools/call": {
					if (mode === "endless") {
						const stream = new ReadableStream({ start: (controller) => { controller.enqueue(new TextEncoder().encode("data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}\n\n")); } });
						return new Response(stream, { headers: { "content-type": "text/event-stream" } });
					}
					const progress = '{"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":1,"progress":1}}';
					const final = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `http:${message.params?.arguments?.text ?? ""}` }] } });
					return new Response(`data: ${progress}\n\ndata: ${final}\n\n`, { headers: { "content-type": "text/event-stream" } });
				}
				default:
					return new Response("", { status: 404 });
			}
		}
	});
	return { url: `http://localhost:${server.port}/mcp`, seen, stop: () => { void server.stop(true); } };
}

function lowerCased(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, name) => { result[name.toLowerCase()] = value; });
	return result;
}

/** The injected request function the plugin builds from requestUrl, built here on fetch for tests. */
export async function fetchRequest(request: HttpRequest): Promise<HttpResponse> {
	const response = await fetch(request.url, { method: request.method, headers: { ...request.headers }, body: request.body });
	return {
		status: response.status,
		headers: lowerCased(response.headers),
		text: await response.text()
	};
}
