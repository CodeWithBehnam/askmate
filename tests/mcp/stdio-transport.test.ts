import { describe, expect, test } from "bun:test";
import { StdioTransport, feedLines } from "../../src/mcp/stdioTransport";
import { fakeChild } from "./helpers";

describe("StdioTransport", () => {
	test("frames messages across chunks and caps runaway lines", () => {
		const first = feedLines({ pending: "" }, '{"a":1}\r\n{"b":', 100);
		expect(first.lines).toEqual(['{"a":1}']);
		const second = feedLines(first.state, "2}\n", 100);
		expect(second.lines).toEqual(['{"b":2}']);
		expect(feedLines({ pending: "" }, "x".repeat(200), 100).overflow).toBe(true);
	});

	test("correlates replies by id, answers legacy pings and refuses other server requests", async () => {
		const fake = fakeChild();
		const transport = new StdioTransport(fake.child);
		const pending = transport.post({ jsonrpc: "2.0", id: 7, method: "tools/list" }, { headers: {}, timeoutMs: 1000 });
		fake.emit('{"jsonrpc":"2.0","id":99,"method":"ping"}\n{"jsonrpc":"2.0","id":5,"method":"roots/list"}\n');
		fake.emit('{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n');
		expect(await pending).toEqual({ kind: "rpc", reply: { kind: "result", id: 7, result: { tools: [] } } });
		const replies = fake.written.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 99, result: {} });
		expect(replies[2]).toMatchObject({ id: 5, error: { code: -32601 } });
	});

	test("tells the server about a cancelled request and rejects on timeout or abort", async () => {
		const fake = fakeChild();
		const transport = new StdioTransport(fake.child);
		await expect(transport.post({ jsonrpc: "2.0", id: 1, method: "tools/call" }, { headers: {}, timeoutMs: 10 })).rejects.toMatchObject({ kind: "timeout" });
		const controller = new AbortController();
		const aborted = transport.post({ jsonrpc: "2.0", id: 2, method: "tools/call" }, { headers: {}, timeoutMs: 1000, signal: controller.signal });
		controller.abort();
		await expect(aborted).rejects.toMatchObject({ kind: "aborted" });
		const cancels = fake.written.map((line) => JSON.parse(line) as { method?: string; params?: { requestId?: number } }).filter((message) => message.method === "notifications/cancelled");
		expect(cancels.map((message) => message.params?.requestId)).toEqual([1, 2]);
	});

	test("rejects everything pending when the process exits, and closes in the documented order", async () => {
		const fake = fakeChild();
		const transport = new StdioTransport(fake.child, { graceMs: 5 });
		const pending = transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, { headers: {}, timeoutMs: 1000 });
		fake.exit(1);
		await expect(pending).rejects.toMatchObject({ kind: "transport" });
		const second = fakeChild();
		const stubborn = new StdioTransport(second.child, { graceMs: 5 });
		await stubborn.close();
		expect(second.kills).toEqual(["stdin-end", "SIGTERM", "SIGKILL"]);
	});
});

describe("StdioTransport hardening", () => {
	test("a line over the cap kills the server and fails the request", async () => {
		const fake = fakeChild();
		const transport = new StdioTransport(fake.child, { maxLineBytes: 50 });
		const pending = transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, { headers: {}, timeoutMs: 1000 });
		fake.emit("x".repeat(80));
		await expect(pending).rejects.toMatchObject({ kind: "protocol" });
		expect(fake.kills).toContain("SIGKILL");
		await expect(transport.post({ jsonrpc: "2.0", id: 2, method: "x" }, { headers: {}, timeoutMs: 100 })).rejects.toMatchObject({ kind: "protocol" });
	});

	test("the default line cap is 8 MiB", () => {
		const eightMiB = 8 * 1024 * 1024;
		expect(feedLines({ pending: "" }, "x".repeat(eightMiB), eightMiB).overflow).toBe(false);
		expect(feedLines({ pending: "" }, "x".repeat(eightMiB + 1), eightMiB).overflow).toBe(true);
	});

	test("an exit message carries the redacted end of stderr", async () => {
		const fake = fakeChild();
		const transport = new StdioTransport(fake.child, { secrets: ["supersecretvalue"] });
		const pending = transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, { headers: {}, timeoutMs: 1000 });
		fake.emitStderr("boot ok\nusing token supersecretvalue and Bearer abcdefghijklmnop1234\nfatal: cannot start\n");
		fake.exit(2);
		const error = (await pending.then(() => new Error("resolved"), (caught: unknown) => caught)) as Error;
		expect(error.message).toContain("fatal: cannot start");
		expect(error.message).not.toContain("supersecretvalue");
		expect(error.message).not.toContain("abcdefghijklmnop1234");
	});

	test("only the end of a long stderr goes into the message", async () => {
		const fake = fakeChild();
		const transport = new StdioTransport(fake.child, { stderrTail: 5000 });
		const pending = transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, { headers: {}, timeoutMs: 1000 });
		fake.emitStderr(`${"a".repeat(3000)}THE END`);
		fake.exit(1);
		const error = (await pending.then(() => new Error("resolved"), (caught: unknown) => caught)) as Error;
		expect(error.message.length).toBeLessThan(1200);
		expect(error.message).toContain("THE END");
	});

	test("a spawn error fails pending work and closing returns at once", async () => {
		const fake = fakeChild();
		const transport = new StdioTransport(fake.child, { graceMs: 5000 });
		const pending = transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, { headers: {}, timeoutMs: 1000 });
		fake.error("spawn nonexistent ENOENT");
		await expect(pending).rejects.toMatchObject({ kind: "transport", message: expect.stringContaining("ENOENT") });
		const started = Date.now();
		await transport.close();
		expect(Date.now() - started).toBeLessThan(1000);
		expect(fake.kills).toEqual([]);
	});

	test("notifications reach subscribers, malformed lines are ignored, unknown ids are ignored", async () => {
		const fake = fakeChild();
		const transport = new StdioTransport(fake.child);
		const seen: string[] = [];
		const stop = transport.onNotification((method) => seen.push(method));
		fake.emit('not json\n{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n{"jsonrpc":"2.0","id":404,"result":{}}\n');
		stop();
		fake.emit('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n');
		expect(seen).toEqual(["notifications/tools/list_changed"]);
	});

	test("a write to a dead pipe becomes a transport failure instead of throwing", async () => {
		const fake = fakeChild();
		const throwing = {
			...fake.child,
			stdin: { write: (): boolean => { throw new Error("write EPIPE"); }, end: () => undefined, on: () => undefined }
		};
		const transport = new StdioTransport(throwing);
		await expect(transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, { headers: {}, timeoutMs: 1000 })).rejects.toMatchObject({ kind: "transport", message: expect.stringContaining("EPIPE") });
	});

	test("an already aborted signal rejects without writing, and a closed transport rejects", async () => {
		const fake = fakeChild();
		const transport = new StdioTransport(fake.child, { graceMs: 5 });
		const controller = new AbortController();
		controller.abort();
		await expect(transport.post({ jsonrpc: "2.0", id: 1, method: "x" }, { headers: {}, timeoutMs: 100, signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
		expect(fake.written).toEqual([]);
		fake.exit(0);
		await transport.close();
		await transport.close();
		await expect(transport.notify({ jsonrpc: "2.0", method: "x" })).rejects.toMatchObject({ kind: "transport" });
	});
});
