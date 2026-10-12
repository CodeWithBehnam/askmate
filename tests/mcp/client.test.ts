import { describe, expect, test } from "bun:test";
import { McpClient } from "../../src/mcp/McpClient";
import { McpClientError, type JsonObject } from "../../src/mcp/protocol";
import { type Responder, config, discover, fail, ok, scripted, tool } from "./helpers";

describe("McpClient negotiation", () => {
	test("modern server over stdio: discover succeeds, no initialize is sent", async () => {
		const transport = scripted("stdio", (message) => discover(message.id));
		const client = await McpClient.connect(transport, config);
		expect(client.session).toMatchObject({ era: "modern", version: "2026-07-28", serverName: "Weather", serverVersion: "1.2.3" });
		expect(transport.sent.map((message) => message.method)).toEqual(["server/discover"]);
		expect(transport.notifications).toEqual([]);
	});

	test("legacy stdio server: method-not-found on discover falls back to initialize and sends initialized", async () => {
		const transport = scripted("stdio", (message) => message.method === "server/discover"
			? fail(message.id, -32601)
			: ok(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "Old", version: "0.1" } }));
		const client = await McpClient.connect(transport, config);
		expect(client.session).toMatchObject({ era: "legacy", version: "2025-11-25", serverName: "Old" });
		expect(transport.sent.map((message) => message.method)).toEqual(["server/discover", "initialize"]);
		expect(transport.notifications).toEqual(["notifications/initialized"]);
	});

	test("a silent stdio server is treated as legacy, a silent HTTP server is an error", async () => {
		const silentThenOk = scripted("stdio", (message, call) => call === 1
			? new McpClientError("timeout", "silent")
			: ok(message.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "Slow", version: "1" } }));
		expect((await McpClient.connect(silentThenOk, config)).session.version).toBe("2025-06-18");
		const silentHttp = scripted("http", () => new McpClientError("timeout", "silent"));
		await expect(McpClient.connect(silentHttp, config)).rejects.toMatchObject({ kind: "timeout" });
	});

	test("HTTP: a plain 400 falls back to initialize, a 401 asks for a token, a retired SSE server gets a clear message", async () => {
		const legacy = scripted("http", (message) => message.method === "server/discover"
			? { kind: "http", http: { status: 400, headers: {}, text: "Bad Request" } }
			: ok(message.id, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "L", version: "1" } }));
		expect((await McpClient.connect(legacy, config)).session.era).toBe("legacy");
		const protectedServer = scripted("http", () => ({ kind: "http", http: { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"' }, text: "" } }));
		await expect(McpClient.connect(protectedServer, config)).rejects.toMatchObject({ kind: "auth_required" });
		const sseOnly = scripted("http", () => ({ kind: "http", http: { status: 405, headers: {}, text: "" } }));
		await expect(McpClient.connect(sseOnly, config)).rejects.toMatchObject({ kind: "unsupported" });
	});

	test("refuses a legacy version it does not speak", async () => {
		const transport = scripted("stdio", (message) => message.method === "server/discover"
			? fail(message.id, -32601)
			: ok(message.id, { protocolVersion: "2024-11-05", capabilities: {} }));
		await expect(McpClient.connect(transport, config)).rejects.toMatchObject({ kind: "unsupported" });
	});

	test("an unsupported-version error (-32022) is retried once with the highest mutual modern version", async () => {
		const transport = scripted("http", (message, call) => call === 1
			? { kind: "http", http: { status: 400, headers: {}, text: JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32022, message: "version", data: { supported: ["2026-07-28"] } } }) } }
			: discover(message.id));
		const client = await McpClient.connect(transport, config);
		expect(client.session.era).toBe("modern");
		expect(transport.sent.map((message) => message.method)).toEqual(["server/discover", "server/discover"]);
	});

	test("an unsupported-version error that lists only legacy versions falls back to initialize", async () => {
		const transport = scripted("stdio", (message) => message.method === "server/discover"
			? fail(message.id, -32022)
			: ok(message.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "L", version: "1" } }));
		expect((await McpClient.connect(transport, config)).session.version).toBe("2025-06-18");
	});

	test("a cached legacy era skips the discover probe", async () => {
		const transport = scripted("stdio", (message) => ok(message.id, { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "Old", version: "1" } }));
		const client = await McpClient.connect(transport, config, undefined, { era: "legacy", version: "2025-11-25" });
		expect(client.session.era).toBe("legacy");
		expect(transport.sent.map((message) => message.method)).toEqual(["initialize"]);
	});

	test("a wrong legacy hint probes again: the server was upgraded to the modern protocol", async () => {
		const transport = scripted("stdio", (message) => message.method === "initialize"
			? fail(message.id, -32601, "Method not found")
			: discover(message.id));
		const client = await McpClient.connect(transport, config, undefined, { era: "legacy", version: "2025-11-25" });
		expect(client.session.era).toBe("modern");
		expect(transport.sent.map((message) => message.method)).toEqual(["initialize", "server/discover"]);
	});

	test("a modern hint starts from the hinted version", async () => {
		const transport = scripted("stdio", (message) => discover(message.id));
		await McpClient.connect(transport, config, undefined, { era: "modern", version: "2026-07-28" });
		expect(transport.sent[0]?.params?._meta).toMatchObject({ "io.modelcontextprotocol/protocolVersion": "2026-07-28" });
	});

	test("a transport failure while connecting is never mistaken for a legacy server", async () => {
		const transport = scripted("stdio", () => new McpClientError("transport", "spawn npx ENOENT"));
		await expect(McpClient.connect(transport, config, undefined, { era: "legacy", version: "2025-11-25" })).rejects.toMatchObject({ kind: "transport" });
		expect(transport.sent).toHaveLength(1);
	});
});

describe("McpClient tools", () => {
	test("paginates (an empty cursor is a real cursor), drops bad and duplicate tools, and honours ttlMs", async () => {
		let clock = 1_000;
		const pages: Record<string, JsonObject> = {
			"": { resultType: "complete", tools: [tool("a"), { nope: true }], nextCursor: "", ttlMs: 500 },
			"empty": { resultType: "complete", tools: [tool("a"), tool("b")], ttlMs: 900 }
		};
		let listCalls = 0;
		const transport = scripted("stdio", (message) => {
			if (message.method === "server/discover") {
				return discover(message.id);
			}
			listCalls += 1;
			const cursor = (message.params?.cursor as string | undefined);
			return ok(message.id, cursor === undefined ? pages[""] : pages.empty);
		});
		const client = await McpClient.connect(transport, { ...config, now: () => clock });
		const first = await client.listTools();
		expect(first.tools.map((entry) => entry.name)).toEqual(["a", "b"]);
		expect(first.dropped).toBe(2);
		expect(first.expiresAt).toBe(1_500);
		expect(listCalls).toBe(2);
		await client.listTools();
		expect(listCalls).toBe(2);
		clock = 2_000;
		await client.listTools();
		expect(listCalls).toBe(4);
	});

	test("callTool only reaches tools in the catalogue and never retries a transport failure", async () => {
		let calls = 0;
		const transport = scripted("stdio", (message) => {
			if (message.method === "server/discover") {
				return discover(message.id);
			}
			if (message.method === "tools/list") {
				return ok(message.id, { resultType: "complete", tools: [tool("search")], ttlMs: 60_000 });
			}
			calls += 1;
			return new McpClientError("transport", "pipe closed");
		});
		const client = await McpClient.connect(transport, config);
		await expect(client.callTool("delete_everything", {})).rejects.toMatchObject({ kind: "protocol" });
		await expect(client.callTool("search", { q: "x" })).rejects.toMatchObject({ kind: "transport" });
		expect(calls).toBe(1);
	});

	test("retries a requestState-only input_required, refuses real input requests", async () => {
		let attempts = 0;
		const responder: Responder = (message) => {
			if (message.method === "server/discover") {
				return discover(message.id);
			}
			if (message.method === "tools/list") {
				return ok(message.id, { resultType: "complete", tools: [tool("search")], ttlMs: 60_000 });
			}
			attempts += 1;
			if (attempts === 1) {
				return ok(message.id, { resultType: "input_required", requestState: "opaque" });
			}
			if (attempts === 2) {
				expect((message.params as JsonObject).requestState).toBe("opaque");
				return ok(message.id, { resultType: "complete", content: [{ type: "text", text: "found" }] });
			}
			return ok(message.id, { resultType: "input_required", inputRequests: { a: { method: "elicitation/create", params: {} } } });
		};
		const client = await McpClient.connect(scripted("stdio", responder), config);
		const result = await client.callTool("search", { q: "x" });
		expect(result.content).toEqual([{ type: "text", text: "found" }]);
		await expect(client.callTool("search", { q: "y" })).rejects.toMatchObject({ kind: "input_required" });
	});

	test("a Stop pressed between retry rounds ends the call before another request is sent", async () => {
		const controller = new AbortController();
		const transport = scripted("http", (message) => {
			if (message.method === "server/discover") {
				return discover(message.id);
			}
			if (message.method === "tools/list") {
				return ok(message.id, { resultType: "complete", tools: [tool("search")], ttlMs: 60_000 });
			}
			controller.abort();
			return ok(message.id, { resultType: "input_required", requestState: "opaque" });
		});
		const client = await McpClient.connect(transport, config);
		await expect(client.callTool("search", { q: "x" }, controller.signal)).rejects.toMatchObject({ kind: "aborted" });
		expect(transport.sent.filter((message) => message.method === "tools/call")).toHaveLength(1);
	});

	test("a signal that is already aborted sends no request at all", async () => {
		const transport = scripted("http", (message) => (message.method === "server/discover" ? discover(message.id) : ok(message.id, { resultType: "complete", tools: [tool("search")], ttlMs: 60_000 })));
		const client = await McpClient.connect(transport, config);
		await client.listTools();
		const before = transport.sent.length;
		const stopped = new AbortController();
		stopped.abort();
		await expect(client.callTool("search", {}, stopped.signal)).rejects.toMatchObject({ kind: "aborted" });
		expect(transport.sent).toHaveLength(before);
	});

	test("a legacy 404 on a session re-runs initialize once and repeats the request", async () => {
		const state = { hasSession: true };
		let listAttempts = 0;
		const transport = scripted("http", (message) => {
			if (message.method === "server/discover") {
				return { kind: "http", http: { status: 400, headers: {}, text: "" } };
			}
			if (message.method === "initialize") {
				state.hasSession = true;
				return ok(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "S", version: "1" } });
			}
			listAttempts += 1;
			return listAttempts === 1
				? { kind: "http", http: { status: 404, headers: {}, text: "" } }
				: ok(message.id, { tools: [tool("search")] });
		}, state);
		const client = await McpClient.connect(transport, config);
		const catalogue = await client.listTools();
		expect(catalogue.tools).toHaveLength(1);
		expect(transport.resets).toBe(1);
		expect(transport.sent.filter((message) => message.method === "initialize")).toHaveLength(2);
	});

	test("tools/call is never repeated after a lost session: the client reconnects and the user decides", async () => {
		const state = { hasSession: true };
		let toolCalls = 0;
		const transport = scripted("http", (message) => {
			if (message.method === "server/discover") {
				return { kind: "http", http: { status: 400, headers: {}, text: "" } };
			}
			if (message.method === "initialize") {
				state.hasSession = true;
				return ok(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "S", version: "1" } });
			}
			if (message.method === "tools/list") {
				return ok(message.id, { tools: [tool("search")] });
			}
			toolCalls += 1;
			return { kind: "http", http: { status: 404, headers: {}, text: "" } };
		}, state);
		const client = await McpClient.connect(transport, config);
		await expect(client.callTool("search", { q: "x" })).rejects.toMatchObject({ kind: "transport" });
		expect(toolCalls).toBe(1);
		expect(transport.resets).toBe(1);
		expect(transport.sent.filter((message) => message.method === "initialize")).toHaveLength(2);
	});

	test("list_changed marks the listing stale but a run keeps reading the listing it started with", async () => {
		let version = 1;
		let listCalls = 0;
		const transport = scripted("stdio", (message) => {
			if (message.method === "server/discover") {
				return discover(message.id);
			}
			if (message.method === "tools/list") {
				listCalls += 1;
				return ok(message.id, { resultType: "complete", tools: [tool(version === 1 ? "old" : "new")], ttlMs: 600_000 });
			}
			return ok(message.id, { resultType: "complete", content: [{ type: "text", text: "ran" }] });
		});
		const client = await McpClient.connect(transport, config);
		expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(["old"]);
		version = 2;
		transport.emit("notifications/tools/list_changed");
		expect(client.currentCatalogue?.tools.map((entry) => entry.name)).toEqual(["old"]);
		expect((await client.callTool("old", {})).content).toEqual([{ type: "text", text: "ran" }]);
		expect(listCalls).toBe(1);
		expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(["new"]);
		expect(listCalls).toBe(2);
		transport.emit("notifications/prompts/list_changed");
		await client.listTools();
		expect(listCalls).toBe(2);
	});

	test("a list_changed that arrives while the list is being read leaves the result already stale", async () => {
		let listCalls = 0;
		const transport = scripted("stdio", (message) => {
			if (message.method === "server/discover") {
				return discover(message.id);
			}
			listCalls += 1;
			if (listCalls === 1) {
				transport.emit("notifications/tools/list_changed");
			}
			return ok(message.id, { resultType: "complete", tools: [tool("a")], ttlMs: 600_000 });
		});
		const client = await McpClient.connect(transport, config);
		await client.listTools();
		await client.listTools();
		expect(listCalls).toBe(2);
	});

	test("a legacy server's listing is re-read after the maximum age", async () => {
		let clock = 0;
		let listCalls = 0;
		const transport = scripted("stdio", (message) => {
			if (message.method === "server/discover") {
				return fail(message.id, -32601);
			}
			if (message.method === "initialize") {
				return ok(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "L", version: "1" } });
			}
			listCalls += 1;
			return ok(message.id, { tools: [tool("a")] });
		});
		const client = await McpClient.connect(transport, { ...config, now: () => clock, legacyCatalogueMaxAgeMs: 1000 });
		await client.listTools();
		clock = 999;
		await client.listTools();
		expect(listCalls).toBe(1);
		clock = 1000;
		await client.listTools();
		expect(listCalls).toBe(2);
	});

	test("a server without the tools capability lists nothing and is not asked", async () => {
		const transport = scripted("stdio", (message) => discover(message.id, { capabilities: {} }));
		const client = await McpClient.connect(transport, config);
		expect((await client.listTools()).tools).toEqual([]);
		expect(transport.sent.map((message) => message.method)).toEqual(["server/discover"]);
	});

	test("tools with oversized schemas are hidden and counted", async () => {
		const huge = { type: "object", properties: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`p${index}`, { type: "string", description: "x".repeat(50) }])) };
		const transport = scripted("stdio", (message) => message.method === "server/discover"
			? discover(message.id)
			: ok(message.id, { resultType: "complete", tools: [tool("small"), tool("big", { inputSchema: huge })] }));
		const client = await McpClient.connect(transport, { ...config, maxSchemaChars: 2000 });
		const catalogue = await client.listTools();
		expect(catalogue.tools.map((entry) => entry.name)).toEqual(["small"]);
		expect(catalogue.dropped).toBe(1);
	});

	test("the number of pages and tools is bounded", async () => {
		let pages = 0;
		const transport = scripted("stdio", (message) => {
			if (message.method === "server/discover") {
				return discover(message.id);
			}
			pages += 1;
			return ok(message.id, { resultType: "complete", tools: [tool(`t${pages}a`), tool(`t${pages}b`)], nextCursor: `c${pages}` });
		});
		const client = await McpClient.connect(transport, { ...config, maxPages: 3, maxTools: 5 });
		const catalogue = await client.listTools();
		expect(pages).toBe(3);
		expect(catalogue.tools).toHaveLength(5);
		expect(catalogue.dropped).toBe(1);
	});

	test("an HTTP error status that carries a JSON-RPC error shows the server's message", async () => {
		const transport = scripted("http", (message) => {
			if (message.method === "server/discover") {
				return discover(message.id);
			}
			if (message.method === "tools/list") {
				return ok(message.id, { resultType: "complete", tools: [tool("search")] });
			}
			return { kind: "http", http: { status: 400, headers: { "content-type": "application/json" }, text: JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "query is required" } }) } };
		});
		const client = await McpClient.connect(transport, config);
		await expect(client.callTool("search", {})).rejects.toMatchObject({ kind: "server_error", message: expect.stringContaining("query is required") });
	});

	test("a 401 or 403 after connecting asks for a token, other statuses are transport errors", async () => {
		let status = 401;
		const transport = scripted("http", (message) => {
			if (message.method === "server/discover") {
				return discover(message.id);
			}
			return { kind: "http", http: { status, headers: { "www-authenticate": 'Bearer scope="read"' }, text: "" } };
		});
		const client = await McpClient.connect(transport, config);
		await expect(client.listTools()).rejects.toMatchObject({ kind: "auth_required", detail: { wwwAuthenticate: 'Bearer scope="read"' } });
		status = 403;
		await expect(client.listTools()).rejects.toMatchObject({ kind: "auth_required" });
		status = 502;
		await expect(client.listTools()).rejects.toMatchObject({ kind: "transport" });
	});

	test("an unknown result type and a retry loop are protocol errors", async () => {
		const responder: Responder = (message) => {
			if (message.method === "server/discover") {
				return discover(message.id);
			}
			if (message.method === "tools/list") {
				return ok(message.id, { resultType: "complete", tools: [tool("a"), tool("b")] });
			}
			return message.params?.name === "a"
				? ok(message.id, { resultType: "mystery" })
				: ok(message.id, { resultType: "input_required", requestState: "again" });
		};
		const client = await McpClient.connect(scripted("stdio", responder), config);
		await expect(client.callTool("a", {})).rejects.toMatchObject({ kind: "protocol" });
		await expect(client.callTool("b", {})).rejects.toMatchObject({ kind: "protocol", message: expect.stringContaining("kept asking") });
	});

	test("a per-call timeout overrides the default and the modern HTTP headers mirror the tool name", async () => {
		const transport = scripted("http", (message) => {
			if (message.method === "server/discover") {
				return discover(message.id);
			}
			if (message.method === "tools/list") {
				return ok(message.id, { resultType: "complete", tools: [tool("search")] });
			}
			return ok(message.id, { resultType: "complete", content: [] });
		});
		const client = await McpClient.connect(transport, config);
		await client.callTool("search", {}, undefined, { timeoutMs: 123 });
		expect(transport.timeouts.at(-1)).toBe(123);
		expect(transport.headers.at(-1)).toMatchObject({ "Mcp-Method": "tools/call", "Mcp-Name": "search" });
		await client.callTool("search", {});
		expect(transport.timeouts.at(-1)).toBe(config.callTimeoutMs);
	});

	test("close stops listening and closes the transport once", async () => {
		const transport = scripted("stdio", (message) => discover(message.id));
		const client = await McpClient.connect(transport, config);
		await client.close();
		expect(transport.closed).toBe(1);
	});
});
