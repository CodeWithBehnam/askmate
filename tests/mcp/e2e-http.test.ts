import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_CLIENT_CONFIG, McpClient } from "../../src/mcp/McpClient";
import { McpService } from "../../src/mcp/McpService";
import { HttpTransport, validateServerUrl } from "../../src/mcp/httpTransport";
import { createHarness, httpServer, secret } from "./fake-host";
import { type HttpFixture, type HttpFixtureMode, fetchRequest, startHttpFixture } from "./fixtures/http-server";

/** These tests talk to a real local HTTP server, through the same transport the plugin uses (with fetch standing in for requestUrl). */

const identity = { name: "askmate", version: "e2e" };
const clientConfig = { ...DEFAULT_CLIENT_CONFIG, identity, connectTimeoutMs: 3000, listTimeoutMs: 3000, callTimeoutMs: 3000 };
const fixtures: HttpFixture[] = [];

afterEach(() => {
	fixtures.splice(0).forEach((fixture) => fixture.stop());
});

function serve(mode: HttpFixtureMode): HttpFixture {
	const fixture = startHttpFixture(mode);
	fixtures.push(fixture);
	return fixture;
}

const transportFor = (fixture: HttpFixture, token: () => string | null = () => null): HttpTransport =>
	new HttpTransport(validateServerUrl(fixture.url), fetchRequest, token);

describe("Streamable HTTP end to end", () => {
	test("modern server: discover, list, a buffered SSE tool reply, and the SEP-2243 headers", async () => {
		const fixture = serve("modern");
		const client = await McpClient.connect(transportFor(fixture), clientConfig);
		expect(client.session).toMatchObject({ era: "modern", serverName: "HttpModern" });
		const result = await client.callTool("echo", { text: "ünï" });
		expect(result.content).toEqual([{ type: "text", text: "http:ünï" }]);
		const call = fixture.seen.find((entry) => entry.headers["mcp-method"] === "tools/call");
		expect(call?.headers).toMatchObject({
			"mcp-name": "echo",
			"mcp-protocol-version": "2026-07-28",
			"mcp-param-text": "=?base64?w7xuw68=?=",
			accept: "application/json, text/event-stream"
		});
		const probe = fixture.seen[0];
		expect(probe?.headers["mcp-method"]).toBe("server/discover");
		await client.close();
		expect(fixture.seen.some((entry) => entry.method === "DELETE")).toBe(false);
	});

	test("legacy server: initialize mints a session that every later request carries, and close ends it", async () => {
		const fixture = serve("legacy");
		const client = await McpClient.connect(transportFor(fixture), clientConfig);
		expect(client.session).toMatchObject({ era: "legacy", version: "2025-06-18", serverName: "HttpLegacy" });
		const result = await client.callTool("echo", { text: "plain" });
		expect(result.content).toEqual([{ type: "text", text: "http:plain" }]);
		const later = fixture.seen.filter((entry) => (entry.body as { method?: string } | null)?.method === "tools/call");
		expect(later[0]?.headers).toMatchObject({ "mcp-session-id": "sess-xyz", "mcp-protocol-version": "2025-06-18" });
		expect(fixture.seen.some((entry) => (entry.body as { method?: string } | null)?.method === "notifications/initialized")).toBe(true);
		await client.close();
		expect(fixture.seen.at(-1)?.method).toBe("DELETE");
		expect(fixture.seen.at(-1)?.headers).toMatchObject({ "mcp-session-id": "sess-xyz", "mcp-protocol-version": "2025-06-18" });
	});

	test("a protected server gives auth_required without a token, works with one, and reads the token at send time", async () => {
		const fixture = serve("protected");
		await expect(McpClient.connect(transportFor(fixture), clientConfig)).rejects.toMatchObject({
			kind: "auth_required",
			detail: { wwwAuthenticate: expect.stringContaining("mcp:tools") }
		});
		let token: string | null = "Bearer bad";
		const transport = transportFor(fixture, () => token);
		await expect(McpClient.connect(transport, clientConfig)).rejects.toMatchObject({ kind: "auth_required" });
		token = "Bearer good";
		const client = await McpClient.connect(transport, clientConfig);
		expect((await client.listTools()).tools).toHaveLength(1);
		token = "Bearer revoked";
		await expect(client.callTool("echo", { text: "x" })).rejects.toMatchObject({ kind: "auth_required" });
	});

	test("a retired HTTP+SSE server is refused with a clear message", async () => {
		const fixture = serve("sse-only");
		await expect(McpClient.connect(transportFor(fixture), clientConfig)).rejects.toMatchObject({
			kind: "unsupported",
			message: expect.stringContaining("HTTP+SSE")
		});
	});

	test("an SSE reply that never ends times out cleanly instead of hanging", async () => {
		const fixture = serve("endless");
		const client = await McpClient.connect(transportFor(fixture), { ...clientConfig, callTimeoutMs: 300 });
		const started = Date.now();
		await expect(client.callTool("echo", { text: "x" })).rejects.toMatchObject({ kind: "timeout" });
		expect(Date.now() - started).toBeLessThan(2500);
	}, 10_000);

	test("a server that is not listening is a transport error with no secret in it", async () => {
		const transport = new HttpTransport(validateServerUrl("http://localhost:9/mcp"), fetchRequest, () => "Bearer secret-token-0123456789");
		const error = await McpClient.connect(transport, clientConfig).then(() => null, (caught: unknown) => caught);
		expect(error).toMatchObject({ kind: "transport" });
		expect(String((error as Error).message)).not.toContain("secret-token-0123456789");
	});

	test("McpService over real HTTP: trust, token from secrets, approval, call and shutdown", async () => {
		const fixture = serve("protected");
		const harness = createHarness({ servers: [httpServer("remote", { url: fixture.url, bearerSecretId: "askmate-mcp-remote-token" })] });
		harness.secrets.set("askmate-mcp-remote-token", "good");
		const service = new McpService({ ...harness.host, requestHttp: fetchRequest });
		expect(await service.trust("remote")).toEqual({ kind: "trusted" });
		const snapshot = await service.prepareRun();
		expect(snapshot.tools.map((tool) => tool.modelName)).toEqual(["remote__echo"]);
		const outcome = await service.callTool({ snapshot, callId: "1", modelName: "remote__echo", args: { text: "service" }, chatId: "chat" }, new AbortController().signal);
		expect(outcome).toMatchObject({ status: "ok" });
		expect(outcome.text).toContain("http:service");
		harness.secrets.set("askmate-mcp-remote-token", "rotated-and-wrong");
		const refused = await service.callTool({ snapshot, callId: "2", modelName: "remote__echo", args: { text: "again" }, chatId: "chat" }, new AbortController().signal);
		expect(refused).toMatchObject({ status: "failed", failure: "auth_required" });
		expect(JSON.stringify(refused)).not.toContain("rotated-and-wrong");
		await service.shutdown();
	});

	test("a header secret is sent to the real server and a missing one blocks the connection", async () => {
		const fixture = serve("modern");
		const harness = createHarness({ servers: [httpServer("remote", { url: fixture.url, headers: { "X-Team-Key": secret("askmate-mcp-remote-x-team-key") } })] });
		const service = new McpService({ ...harness.host, requestHttp: fetchRequest });
		await service.trust("remote");
		await service.prepareRun();
		expect(service.status()[0]?.state).toMatchObject({ kind: "error", message: expect.stringContaining("X-Team-Key") });
		expect(fixture.seen).toHaveLength(0);
		harness.secrets.set("askmate-mcp-remote-x-team-key", "team-key-value");
		await service.testConnection("remote");
		expect(service.status()[0]?.state.kind).toBe("ready");
		expect(fixture.seen[0]?.headers["x-team-key"]).toBe("team-key-value");
		await service.shutdown();
	});
});
