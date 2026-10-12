import { DEFAULT_CLIENT_CONFIG, type McpClientConfig } from "../../src/mcp/McpClient";
import type { JsonObject, JsonRpcRequest } from "../../src/mcp/protocol";
import { McpClientError } from "../../src/mcp/protocol";
import type { ChildLike } from "../../src/mcp/stdioTransport";
import type { McpTransport, NotificationListener, PostOptions, TransportReply } from "../../src/mcp/transport";

export const identity = { name: "askmate", version: "9.9.9" };
export const config: McpClientConfig = { ...DEFAULT_CLIENT_CONFIG, identity, connectTimeoutMs: 50, listTimeoutMs: 50, callTimeoutMs: 50 };

export type Responder = (message: JsonRpcRequest, call: number) => TransportReply | McpClientError;

export interface ScriptedTransport extends McpTransport {
	sent: JsonRpcRequest[];
	headers: Record<string, string>[];
	timeouts: number[];
	notifications: string[];
	resets: number;
	closed: number;
	emit(method: string): void;
}

/** A transport whose replies come from a function, so client behaviour can be tested without a process or a socket. */
export function scripted(kind: "stdio" | "http", responder: Responder, state: { hasSession?: boolean } = {}): ScriptedTransport {
	const sent: JsonRpcRequest[] = [];
	const headers: Record<string, string>[] = [];
	const timeouts: number[] = [];
	const notifications: string[] = [];
	const listeners = new Set<NotificationListener>();
	const transport: ScriptedTransport = {
		kind,
		sent,
		headers,
		timeouts,
		notifications,
		resets: 0,
		closed: 0,
		get hasSession() {
			return state.hasSession ?? false;
		},
		resetSession() {
			transport.resets += 1;
			state.hasSession = false;
		},
		post(message: JsonRpcRequest, options: PostOptions): Promise<TransportReply> {
			sent.push(message);
			headers.push({ ...options.headers });
			timeouts.push(options.timeoutMs);
			const out = responder(message, sent.length);
			return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
		},
		notify(message: { method: string }): Promise<void> {
			notifications.push(message.method);
			return Promise.resolve();
		},
		onNotification(listener: NotificationListener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		emit(method: string) {
			listeners.forEach((listener) => listener(method));
		},
		close() {
			transport.closed += 1;
			return Promise.resolve();
		}
	};
	return transport;
}

export const ok = (id: number | string, result: JsonObject): TransportReply => ({ kind: "rpc", reply: { kind: "result", id, result } });
export const fail = (id: number | string, code: number, message = "nope"): TransportReply => ({ kind: "rpc", reply: { kind: "error", id, error: { code, message } } });
export const discover = (id: number | string, extra: JsonObject = {}): TransportReply => ok(id, {
	resultType: "complete",
	supportedVersions: ["2026-07-28"],
	capabilities: { tools: {} },
	_meta: { "io.modelcontextprotocol/serverInfo": { name: "Weather", version: "1.2.3" } },
	ttlMs: 1000,
	cacheScope: "public",
	...extra
});

export const tool = (name: string, extra: JsonObject = {}): JsonObject => ({
	name,
	description: `${name} tool`,
	inputSchema: { type: "object", properties: { q: { type: "string" } } },
	...extra
});

export interface FakeChild {
	child: ChildLike;
	written: string[];
	kills: string[];
	emit(text: string): void;
	emitStderr(text: string): void;
	exit(code: number): void;
	error(message: string): void;
}

/** A child process stand-in. Records writes and kills; the test decides what the "server" says. */
export function fakeChild(): FakeChild {
	const written: string[] = [];
	const handlers: {
		stdout: Array<(chunk: string) => void>;
		stderr: Array<(chunk: string) => void>;
		exit: Array<(code: number | null, signal: string | null) => void>;
		error: Array<(error: Error) => void>;
	} = { stdout: [], stderr: [], exit: [], error: [] };
	const kills: string[] = [];
	const child: ChildLike = {
		stdin: { write: (data) => { written.push(data); return true; }, end: () => { kills.push("stdin-end"); }, on: () => undefined },
		stdout: { on: (_event, listener) => { handlers.stdout.push((chunk) => listener(chunk)); } },
		stderr: { on: (_event, listener) => { handlers.stderr.push((chunk) => listener(chunk)); } },
		on: (event: string, listener: (...args: never[]) => void) => {
			if (event === "exit") {
				handlers.exit.push(listener as (code: number | null, signal: string | null) => void);
			} else if (event === "error") {
				handlers.error.push(listener as (error: Error) => void);
			}
		},
		kill: (signal) => { kills.push(signal ?? "SIGTERM"); return true; }
	};
	return {
		child,
		written,
		kills,
		emit: (text) => handlers.stdout.forEach((handler) => handler(text)),
		emitStderr: (text) => handlers.stderr.forEach((handler) => handler(text)),
		exit: (code) => handlers.exit.forEach((handler) => handler(code, null)),
		error: (message) => handlers.error.forEach((handler) => handler(new Error(message)))
	};
}
