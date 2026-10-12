import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CLIENT_CONFIG, McpClient } from "../../src/mcp/McpClient";
import { McpService } from "../../src/mcp/McpService";
import { spawnChild } from "../../src/mcp/launch";
import { buildChildEnv, planSpawn } from "../../src/mcp/spawnPlan";
import { StdioTransport } from "../../src/mcp/stdioTransport";
import { createHarness, plain, stdioServer } from "./fake-host";

/** These tests run a real child process (a small bun script) through the same launch code the plugin uses. */

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.ts", import.meta.url));
const identity = { name: "askmate", version: "e2e" };
const clientConfig = { ...DEFAULT_CLIENT_CONFIG, identity, connectTimeoutMs: 8000, listTimeoutMs: 8000, callTimeoutMs: 8000 };

let scratch = "";
let counter = 0;
const transports: StdioTransport[] = [];

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "askmate-stdio-"));
});

afterAll(async () => {
	await Promise.all(transports.map((transport) => transport.close()));
	await rm(scratch, { recursive: true, force: true });
});

async function readLog(path: string): Promise<string[]> {
	try {
		return (await readFile(path, "utf8")).split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

async function waitForLog(path: string, line: string, timeoutMs = 3000): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	let lines = await readLog(path);
	while (!lines.some((entry) => entry.startsWith(line)) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		lines = await readLog(path);
	}
	return lines;
}

function launch(env: Record<string, string>, graceMs = 300): { transport: StdioTransport; log: string; pid: () => number | undefined } {
	counter += 1;
	const log = join(scratch, `server-${counter}.log`);
	const serverEnv = { FIXTURE_LOG: log, ...env };
	const plan = planSpawn({ command: process.execPath, args: [fixture], env: serverEnv }, process.platform);
	const child = spawnChild({ plan, env: buildChildEnv(process.env, null, serverEnv) });
	const transport = new StdioTransport(child, { graceMs });
	transports.push(transport);
	return { transport, log, pid: () => (child as unknown as { pid?: number }).pid };
}

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("stdio end to end", () => {
	for (const mode of ["modern", "legacy"] as const) {
		test(`${mode} server: connect, list, call, close`, async () => {
			const { transport, log } = launch({ MODE: mode });
			const client = await McpClient.connect(transport, clientConfig);
			expect(client.session.era).toBe(mode);
			expect(client.session.serverName).toBe(mode === "modern" ? "FixtureModern" : "FixtureLegacy");
			const catalogue = await client.listTools();
			expect(catalogue.tools.map((tool) => tool.name)).toEqual(["echo", "env", "sleep", "repeat"]);
			const result = await client.callTool("echo", { text: "hi" });
			expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
			await client.close();
			expect(await waitForLog(log, "stdin-closed")).toContain("stdin-closed");
		}, 15_000);
	}

	test("the server only sees the allow-listed environment and its own entries", async () => {
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-must-not-reach-the-server-0123456789";
		try {
			const { transport } = launch({ MODE: "modern", ASKMATE_CUSTOM: "from-settings" });
			const client = await McpClient.connect(transport, clientConfig);
			const read = async (name: string): Promise<string> => {
				const result = await client.callTool("env", { name });
				return result.content[0]?.type === "text" ? result.content[0].text : "";
			};
			expect(await read("OPENAI_API_KEY")).toBe("(unset)");
			expect(await read("ASKMATE_CUSTOM")).toBe("from-settings");
			expect(await read("PATH")).not.toBe("(unset)");
			await client.close();
		} finally {
			if (previous === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = previous;
			}
		}
	}, 15_000);

	test("a large reply with multi-byte characters arrives intact across read boundaries", async () => {
		const { transport } = launch({ MODE: "modern" });
		const client = await McpClient.connect(transport, clientConfig);
		const unit = "é世🙂";
		const result = await client.callTool("repeat", { text: unit, times: 60_000 });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text.length).toBe(unit.length * 60_000);
		expect(text).toBe(unit.repeat(60_000));
		expect(text).not.toContain("�");
		await client.close();
	}, 15_000);

	test("Stop sends notifications/cancelled to the server and rejects the call", async () => {
		const { transport, log } = launch({ MODE: "modern" });
		const client = await McpClient.connect(transport, clientConfig);
		const controller = new AbortController();
		const pending = client.callTool("sleep", { ms: 5000 }, controller.signal);
		setTimeout(() => controller.abort(), 100);
		await expect(pending).rejects.toMatchObject({ kind: "aborted" });
		expect((await waitForLog(log, "cancelled")).some((line) => line.startsWith("cancelled "))).toBe(true);
		await client.close();
	}, 15_000);

	test("a call that exceeds its timeout is cancelled on the server and reported as a timeout", async () => {
		const { transport, log } = launch({ MODE: "legacy" });
		const client = await McpClient.connect(transport, clientConfig);
		await expect(client.callTool("sleep", { ms: 5000 }, undefined, { timeoutMs: 150 })).rejects.toMatchObject({ kind: "timeout" });
		expect((await waitForLog(log, "cancelled")).some((line) => line.startsWith("cancelled "))).toBe(true);
		await client.close();
	}, 15_000);

	test("a server that ignores stdin closing and SIGTERM is stopped with SIGKILL", async () => {
		const { transport, log, pid } = launch({ MODE: "modern", STUBBORN: "1" }, 150);
		const client = await McpClient.connect(transport, clientConfig);
		const processId = pid();
		expect(processId).toBeDefined();
		const started = Date.now();
		await client.close();
		expect(Date.now() - started).toBeLessThan(3000);
		const lines = await readLog(log);
		expect(lines).toContain("stdin-closed");
		expect(lines).toContain("sigterm-ignored");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(isAlive(processId ?? 0)).toBe(false);
	}, 15_000);

	test("a legacy server that stays silent on server/discover is reached after the short window, not the whole connect timeout", async () => {
		const { transport, log } = launch({ MODE: "silent-legacy" });
		const started = Date.now();
		const client = await McpClient.connect(transport, { ...clientConfig, connectTimeoutMs: 8000, discoverTimeoutMs: 250 });
		expect(Date.now() - started).toBeLessThan(4000);
		expect(client.session.era).toBe("legacy");
		expect(client.session.serverName).toBe("FixtureLegacy");
		expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo", "env", "sleep", "repeat"]);
		expect(await readLog(log)).toContain("discover-ignored");
		await client.close();
	}, 15_000);

	// A package runner (npx, uvx) or a wrapper script starts the real server as a child. Signalling only the wrapper leaves it running.
	test.skipIf(process.platform === "win32")("closing a server that was started through a wrapper also stops the program the wrapper started", async () => {
		counter += 1;
		const log = join(scratch, `wrapped-${counter}.log`);
		const env = { FIXTURE_LOG: log, MODE: "modern", STUBBORN: "1" };
		// The program ignores stdin closing and SIGTERM, and the shell goes on after it ends, like a wrapper that does not exec.
		const plan = planSpawn({ command: "/bin/sh", args: ["-c", '"$0" "$1"; true', process.execPath, fixture], env }, process.platform);
		const transport = new StdioTransport(spawnChild({ plan, env: buildChildEnv(process.env, null, env) }), { graceMs: 200 });
		transports.push(transport);
		const client = await McpClient.connect(transport, clientConfig);
		const lines = await waitForLog(log, "pid ");
		const grandchild = Number((lines.find((line) => line.startsWith("pid ")) ?? "").slice(4));
		expect(grandchild).toBeGreaterThan(0);
		try {
			expect(isAlive(grandchild)).toBe(true);
			const started = Date.now();
			await client.close();
			expect(Date.now() - started).toBeLessThan(5000);
			const deadline = Date.now() + 2000;
			while (isAlive(grandchild) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect(isAlive(grandchild)).toBe(false);
		} finally {
			if (isAlive(grandchild)) {
				process.kill(grandchild, "SIGKILL");
			}
		}
	}, 20_000);

	test("a command that does not exist fails with a clear transport error", async () => {
		const plan = planSpawn({ command: "askmate-no-such-command", args: [], env: {} }, process.platform);
		const transport = new StdioTransport(spawnChild({ plan, env: {} }), { graceMs: 50 });
		await expect(McpClient.connect(transport, clientConfig)).rejects.toMatchObject({ kind: "transport", message: expect.stringContaining("Could not start the server") });
		await transport.close();
	}, 15_000);

	test("McpService runs the whole flow on a real process: trust, start, approve, call, shut down", async () => {
		counter += 1;
		const log = join(scratch, `service-${counter}.log`);
		const harness = createHarness({
			servers: [stdioServer("fixture", { command: process.execPath, args: [fixture], env: { MODE: plain("modern"), FIXTURE_LOG: plain(log) } })]
		});
		const service = new McpService({
			...harness.host,
			platform: { isDesktopApp: true, os: process.platform, env: process.env },
			launchProcess: spawnChild,
			resolveLoginPath: () => Promise.resolve(null),
			tuning: { client: { connectTimeoutMs: 8000, listTimeoutMs: 8000, callTimeoutMs: 8000 }, stdioGraceMs: 300 }
		});
		expect(await service.trust("fixture")).toEqual({ kind: "trusted" });
		const snapshot = await service.prepareRun();
		expect(snapshot.tools.map((tool) => tool.modelName)).toEqual(["fixture__echo", "fixture__env", "fixture__repeat", "fixture__sleep"]);
		const outcome = await service.callTool({ snapshot, callId: "1", modelName: "fixture__echo", args: { text: "service" }, chatId: "chat" }, new AbortController().signal);
		expect(outcome.status).toBe("ok");
		expect(outcome.text).toContain("echo:service");
		expect(JSON.parse(harness.cards[0]?.argumentsText ?? "{}")).toEqual({ text: "service" });
		await service.shutdown();
		expect(await waitForLog(log, "stdin-closed")).toContain("stdin-closed");
		expect(service.status()[0]?.state.kind).toBe("off");
	}, 20_000);
});
