import { describe, expect, test } from "bun:test";
import { HttpTransport, validateServerUrl, type HttpRequest, type HttpResponse } from "../../src/mcp/httpTransport";
import { McpClientError } from "../../src/mcp/protocol";
import type { PostOptions } from "../../src/mcp/transport";

const options: PostOptions = { headers: { Accept: "application/json", "Content-Type": "application/json" }, timeoutMs: 100 };
const reply = (id: number, extra: Partial<HttpResponse> = {}): HttpResponse => ({
	status: 200,
	headers: { "content-type": "application/json" },
	text: JSON.stringify({ jsonrpc: "2.0", id, result: {} }),
	...extra
});

describe("HttpTransport", () => {
	test("validates URLs", () => {
		expect(validateServerUrl("https://mcp.example.com/mcp").hostname).toBe("mcp.example.com");
		expect(validateServerUrl("http://localhost:3000/mcp").port).toBe("3000");
		expect(() => validateServerUrl("http://example.com/mcp")).toThrow();
		expect(() => validateServerUrl("https://user:pw@example.com/mcp")).toThrow();
		expect(() => validateServerUrl("javascript:alert(1)")).toThrow();
		expect(() => validateServerUrl("https://example.com/mcp#frag")).toThrow();
	});

	test("captures the legacy session id from initialize, sends it afterwards, and sets Authorization only at send time", async () => {
		const seen: HttpRequest[] = [];
		const send = (request: HttpRequest): Promise<HttpResponse> => {
			seen.push(request);
			const body = JSON.parse(request.body ?? "{}") as { id?: number; method?: string };
			return Promise.resolve({
				status: 200,
				headers: { "content-type": "application/json", ...(body.method === "initialize" ? { "mcp-session-id": "sess-1" } : {}) },
				text: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })
			});
		};
		const transport = new HttpTransport(validateServerUrl("https://mcp.example.com/mcp"), send, () => "Bearer t0ken");
		const options: PostOptions = { headers: { Accept: "application/json" }, timeoutMs: 100 };
		await transport.post({ jsonrpc: "2.0", id: 1, method: "initialize" }, options);
		await transport.post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, options);
		expect(seen[0].headers["Mcp-Session-Id"]).toBeUndefined();
		expect(seen[1].headers["Mcp-Session-Id"]).toBe("sess-1");
		expect(seen[1].headers.Authorization).toBe("Bearer t0ken");
		await transport.close();
		expect(seen[2].method).toBe("DELETE");
	});
});

describe("HttpTransport hardening", () => {
	const url = validateServerUrl("https://mcp.example.com/mcp");

	test("the bearer token is read for every request, so a replaced token applies at once", async () => {
		let token: string | null = "Bearer first";
		const seen: string[] = [];
		const send = (request: HttpRequest): Promise<HttpResponse> => {
			seen.push(request.headers.Authorization ?? "(none)");
			return Promise.resolve(reply(1));
		};
		const transport = new HttpTransport(url, send, () => token);
		await transport.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, options);
		token = "Bearer second";
		await transport.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, options);
		token = null;
		await transport.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, options);
		expect(seen).toEqual(["Bearer first", "Bearer second", "(none)"]);
	});

	test("custom headers are added but can never replace protocol headers, the session or the bearer token", async () => {
		const seen: HttpRequest[] = [];
		const send = (request: HttpRequest): Promise<HttpResponse> => {
			seen.push(request);
			return Promise.resolve(reply(1, { headers: { "content-type": "application/json", "mcp-session-id": "s" } }));
		};
		const transport = new HttpTransport(url, send, () => "Bearer real", () => ({ "X-Api-Key": "k", Accept: "text/plain", Authorization: "Bearer imposter", "Mcp-Session-Id": "forged" }));
		await transport.post({ jsonrpc: "2.0", id: 1, method: "initialize" }, options);
		await transport.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, options);
		expect(seen[1]?.headers).toMatchObject({ "X-Api-Key": "k", Accept: "application/json", Authorization: "Bearer real", "Mcp-Session-Id": "s" });
	});

	test("failures from the request function become transport errors with the token and header secrets masked", async () => {
		const send = (): Promise<HttpResponse> => Promise.reject(new Error("net::ERR failed for Bearer sk-abcdefghijklmnopqrstuvwxyz and key-1234567890"));
		const transport = new HttpTransport(url, send, () => "Bearer sk-abcdefghijklmnopqrstuvwxyz", () => ({ "X-Key": "key-1234567890" }));
		const error = await transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, options).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(McpClientError);
		expect((error as McpClientError).kind).toBe("transport");
		expect((error as McpClientError).message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
		expect((error as McpClientError).message).not.toContain("key-1234567890");
		expect((error as McpClientError).message).toContain("[redacted]");
	});

	test("a request that never answers times out, and an abort wins immediately", async () => {
		const never = (): Promise<HttpResponse> => new Promise(() => undefined);
		const transport = new HttpTransport(url, never);
		await expect(transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, { ...options, timeoutMs: 10 })).rejects.toMatchObject({ kind: "timeout" });
		const controller = new AbortController();
		const pending = transport.post({ jsonrpc: "2.0", id: 2, method: "x" }, { ...options, timeoutMs: 1000, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ kind: "aborted" });
		controller.abort();
		await expect(transport.post({ jsonrpc: "2.0", id: 3, method: "x" }, { ...options, signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
	});

	test("an already-aborted signal rejects before anything is sent, for requests and notifications, as on stdio", async () => {
		const sent: HttpRequest[] = [];
		const transport = new HttpTransport(url, (request) => { sent.push(request); return Promise.resolve(reply(1)); });
		const controller = new AbortController();
		controller.abort();
		const stopped = { ...options, signal: controller.signal };
		await expect(transport.post({ jsonrpc: "2.0", id: 1, method: "tools/call" }, stopped)).rejects.toMatchObject({ kind: "aborted" });
		await expect(transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, stopped)).rejects.toMatchObject({ kind: "aborted" });
		expect(sent).toHaveLength(0);
		// A signal that is not aborted still sends.
		await transport.post({ jsonrpc: "2.0", id: 2, method: "tools/call" }, { ...options, signal: new AbortController().signal });
		expect(sent).toHaveLength(1);
	});

	test("a non-2xx reply is handed back for the client to judge, a matching reply in a 2xx body is parsed", async () => {
		const transport = new HttpTransport(url, () => Promise.resolve({ status: 405, headers: {}, text: "no" }));
		expect(await transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, options)).toEqual({ kind: "http", http: { status: 405, headers: {}, text: "no" } });
		const sse = new HttpTransport(url, () => Promise.resolve({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			text: 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\ndata: {"jsonrpc":"2.0","id":9,"result":{"ok":1}}\n\n'
		}));
		expect(await sse.post({ jsonrpc: "2.0", id: 9, method: "x" }, options)).toEqual({ kind: "rpc", reply: { kind: "result", id: 9, result: { ok: 1 } } });
	});

	test("notifications found in a reply body reach subscribers until they unsubscribe", async () => {
		const transport = new HttpTransport(url, () => Promise.resolve({
			status: 200,
			headers: { "content-type": "text/event-stream" },
			text: 'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'
		}));
		const seen: string[] = [];
		const stop = transport.onNotification((method) => seen.push(method));
		await transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, options);
		stop();
		await transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, options);
		expect(seen).toEqual(["notifications/tools/list_changed"]);
	});

	test("notify accepts 202 and any 2xx, and rejects other statuses", async () => {
		const statuses = [202, 200, 500];
		const transport = new HttpTransport(url, () => Promise.resolve({ status: statuses.shift() ?? 500, headers: {}, text: "" }));
		await transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, options);
		await transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, options);
		await expect(transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, options)).rejects.toMatchObject({ kind: "transport" });
	});

	test("closing without a session sends nothing, and a hanging DELETE cannot stall closing", async () => {
		let sent = 0;
		const idle = new HttpTransport(url, () => { sent += 1; return Promise.resolve(reply(1)); });
		await idle.close();
		expect(sent).toBe(0);

		const hanging = new HttpTransport(url, (request) => request.method === "DELETE"
			? new Promise<HttpResponse>(() => undefined)
			: Promise.resolve(reply(1, { headers: { "content-type": "application/json", "mcp-session-id": "s" } })));
		await hanging.post({ jsonrpc: "2.0", id: 1, method: "initialize" }, options);
		expect(hanging.hasSession).toBe(true);
		const started = Date.now();
		await hanging.close();
		expect(Date.now() - started).toBeLessThan(4000);
		expect(hanging.hasSession).toBe(false);
	}, 10_000);

	test("resetSession forgets a legacy session", async () => {
		const transport = new HttpTransport(url, () => Promise.resolve(reply(1, { headers: { "content-type": "application/json", "mcp-session-id": "s" } })));
		await transport.post({ jsonrpc: "2.0", id: 1, method: "initialize" }, options);
		transport.resetSession();
		expect(transport.hasSession).toBe(false);
	});

	test("URL checks cover IPv6 loopback, ports, remote http and non-http schemes", () => {
		expect(validateServerUrl("http://[::1]:8080/mcp").hostname).toBe("[::1]");
		expect(validateServerUrl("http://127.0.0.1/mcp").protocol).toBe("http:");
		expect(() => validateServerUrl("http://192.168.1.5/mcp")).toThrow();
		expect(() => validateServerUrl("ftp://example.com")).toThrow();
		expect(() => validateServerUrl("not a url")).toThrow();
	});
});
