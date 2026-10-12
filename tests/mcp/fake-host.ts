import type {
	ApprovalChoice,
	DeviceTrustStore,
	McpHost,
	ToolApprovalCard,
	TrustRequest
} from "../../src/mcp/host";
import type { McpHttpServerConfig, McpServerConfig, McpSettings, McpStdioServerConfig, McpValue } from "../../src/mcp/config";
import { DEFAULT_MCP_SETTINGS } from "../../src/mcp/config";
import type { HttpRequest, HttpRequestFn, HttpResponse } from "../../src/mcp/httpTransport";
import type { JsonObject } from "../../src/mcp/protocol";
import type { LaunchRequest } from "../../src/mcp/spawnPlan";
import type { ChildLike } from "../../src/mcp/stdioTransport";

export interface FakeTool {
	name: string;
	description?: string;
	title?: string;
	inputSchema?: JsonObject;
	annotations?: JsonObject;
}

/** Behaviour of a pretend MCP server, shared by the HTTP and stdio fakes so both speak the same protocol logic. */
export interface FakeServer {
	era: "modern" | "legacy";
	tools: FakeTool[];
	ttlMs: number;
	/** Every tools/call the server actually ran. */
	calls: Array<{ name: string; args: JsonObject }>;
	/** Methods seen, in order. */
	methods: string[];
	instructions?: string;
	requireToken?: string;
	callResult: (name: string, args: JsonObject) => JsonObject;
	/** Return a value to answer a request yourself (for example an error) instead of the default behaviour. */
	override?: (method: string, params: JsonObject) => JsonObject | null;
}

export function fakeServer(overrides: Partial<FakeServer> = {}): FakeServer {
	return {
		era: "modern",
		tools: [{ name: "search", description: "Search notes", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
		ttlMs: 60_000,
		calls: [],
		methods: [],
		callResult: (name) => ({ content: [{ type: "text", text: `ran ${name}` }] }),
		...overrides
	};
}

/** Answers one JSON-RPC request the way a server of the configured era would. Returns null for notifications. */
export function respond(server: FakeServer, message: { id?: number | string; method: string; params?: JsonObject }): JsonObject | null {
	server.methods.push(message.method);
	if (message.id === undefined) {
		return null;
	}
	const reply = (result: JsonObject): JsonObject => ({ jsonrpc: "2.0", id: message.id as number | string, result });
	const error = (code: number, text: string): JsonObject => ({ jsonrpc: "2.0", id: message.id as number | string, error: { code, message: text } });
	const params = message.params ?? {};
	const overridden = server.override?.(message.method, params);
	if (overridden) {
		return reply(overridden);
	}
	switch (message.method) {
		case "server/discover":
			return server.era === "modern"
				? reply({
					resultType: "complete",
					supportedVersions: ["2026-07-28"],
					capabilities: { tools: {} },
					...(server.instructions === undefined ? {} : { instructions: server.instructions }),
					_meta: { "io.modelcontextprotocol/serverInfo": { name: "Fake", version: "1" } },
					ttlMs: server.ttlMs
				})
				: error(-32601, "Method not found");
		case "initialize":
			return reply({ protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, ...(server.instructions === undefined ? {} : { instructions: server.instructions }), serverInfo: { name: "FakeLegacy", version: "1" } });
		case "tools/list":
			return reply({ ...(server.era === "modern" ? { resultType: "complete", ttlMs: server.ttlMs } : {}), tools: server.tools as unknown as JsonObject[] });
		case "tools/call": {
			const name = String(params.name);
			const args = (params.arguments ?? {}) as JsonObject;
			server.calls.push({ name, args });
			return reply(server.callResult(name, args));
		}
		default:
			return error(-32601, "Method not found");
	}
}

export interface FakeHttp {
	send: HttpRequestFn;
	requests: HttpRequest[];
	server: FakeServer;
}

/** Streamable HTTP front for a FakeServer. A legacy server mints a session on initialize and 404s without it. */
export function fakeHttp(server: FakeServer): FakeHttp {
	const requests: HttpRequest[] = [];
	let session: string | null = null;
	const send: HttpRequestFn = (request) => {
		requests.push(request);
		const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Promise<HttpResponse> =>
			Promise.resolve({ status, headers: { "content-type": "application/json", ...headers }, text: JSON.stringify(body) });
		if (server.requireToken && request.headers.Authorization !== `Bearer ${server.requireToken}`) {
			return Promise.resolve({ status: 401, headers: { "www-authenticate": 'Bearer scope="mcp:tools"' }, text: "" });
		}
		if (request.method === "DELETE") {
			session = null;
			return Promise.resolve({ status: 204, headers: {}, text: "" });
		}
		const message = JSON.parse(request.body ?? "{}") as { id?: number | string; method: string; params?: JsonObject };
		if (server.era === "legacy") {
			if (message.method === "server/discover") {
				return Promise.resolve({ status: 400, headers: {}, text: "Bad Request" });
			}
			if (message.method === "initialize") {
				session = "session-1";
				const body = respond(server, message);
				return json(body, 200, { "mcp-session-id": session });
			}
			if (request.headers["Mcp-Session-Id"] !== session) {
				return Promise.resolve({ status: 404, headers: {}, text: "" });
			}
		}
		const body = respond(server, message);
		return body === null ? Promise.resolve({ status: 202, headers: {}, text: "" }) : json(body);
	};
	return { send, requests, server };
}

export interface FakeProcess {
	child: ChildLike;
	kills: string[];
	stdinEnded: boolean;
	exit(code: number | null): void;
}

/** A child process whose stdin/stdout speak to a FakeServer. `hang` makes it ignore stdin closing so shutdown has to escalate. */
export interface FakeProcessOptions {
	hang?: boolean;
	silent?: boolean;
	/** Methods the server never answers, like a legacy server that does not know server/discover and just stays quiet. */
	ignore?: readonly string[];
	/** Emit a spawn error right after start, like a command that is not on the PATH. */
	spawnError?: string;
}

export function fakeProcess(server: FakeServer, options: FakeProcessOptions = {}): FakeProcess {
	const handlers = { stdout: [] as Array<(chunk: string) => void>, exit: [] as Array<(code: number | null, signal: string | null) => void>, error: [] as Array<(error: Error) => void> };
	let pending = "";
	let exited = false;
	const state: FakeProcess = {
		kills: [],
		stdinEnded: false,
		exit: (code) => {
			if (!exited) {
				exited = true;
				handlers.exit.forEach((handler) => handler(code, null));
			}
		},
		child: {
			stdin: {
				write: (data) => {
					pending += data;
					const lines = pending.split("\n");
					pending = lines.pop() ?? "";
					for (const line of lines.filter(Boolean)) {
						const message = JSON.parse(line) as { id?: number; method: string; params?: JsonObject };
						const body = options.silent || options.ignore?.includes(message.method) ? null : respond(server, message);
						if (body) {
							queueMicrotask(() => handlers.stdout.forEach((handler) => handler(`${JSON.stringify(body)}\n`)));
						}
					}
					return true;
				},
				end: () => {
					state.stdinEnded = true;
					state.kills.push("stdin-end");
					if (!options.hang) {
						queueMicrotask(() => state.exit(0));
					}
				},
				on: () => undefined
			},
			stdout: { on: (_event, listener) => { handlers.stdout.push((chunk) => listener(chunk)); } },
			stderr: { on: () => undefined },
			on: (event: string, listener: (...args: never[]) => void) => {
				if (event === "exit") {
					handlers.exit.push(listener as (code: number | null, signal: string | null) => void);
				} else if (event === "error") {
					handlers.error.push(listener as (error: Error) => void);
				}
			},
			kill: (signal) => {
				state.kills.push(signal ?? "SIGTERM");
				if (signal === "SIGKILL" || (signal === "SIGTERM" && !options.hang)) {
						queueMicrotask(() => state.exit(null));
				}
				return true;
			}
		}
	};
	if (options.spawnError !== undefined) {
		const message = options.spawnError;
		queueMicrotask(() => handlers.error.forEach((handler) => handler(new Error(message))));
	}
	return state;
}

export class MemoryTrustStore implements DeviceTrustStore {
	readonly values = new Map<string, string>();
	get(key: string): string | null {
		return this.values.get(key) ?? null;
	}
	set(key: string, value: string): void {
		this.values.set(key, value);
	}
	remove(key: string): void {
		this.values.delete(key);
	}
}

export const httpServer = (id: string, overrides: Partial<McpHttpServerConfig> = {}): McpHttpServerConfig => ({
	id,
	label: `Server ${id}`,
	enabled: true,
	approval: "always-ask",
	trustsAnnotations: false,
	transport: "http",
	url: `https://${id}.example.com/mcp`,
	headers: {},
	bearerSecretId: null,
	...overrides
});

export const stdioServer = (id: string, overrides: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig => ({
	id,
	label: `Local ${id}`,
	enabled: true,
	approval: "always-ask",
	trustsAnnotations: false,
	transport: "stdio",
	command: "npx",
	args: ["-y", "some-server"],
	env: {},
	...overrides
});

export const plain = (value: string): McpValue => ({ kind: "plain", value });
export const secret = (secretId: string): McpValue => ({ kind: "secret", secretId });

export interface Harness {
	host: McpHost;
	settings: McpSettings;
	trust: MemoryTrustStore;
	secrets: Map<string, string>;
	clock: { now: number };
	logs: string[];
	trustRequests: TrustRequest[];
	cards: ToolApprovalCard[];
	launches: LaunchRequest[];
	processes: FakeProcess[];
	/** Answers for confirmTrust and confirmCall; defaults trust everything and allow once. */
	answers: { trust: boolean | (() => boolean); call: ApprovalChoice | ((card: ToolApprovalCard) => ApprovalChoice | Promise<ApprovalChoice>) };
	setServers(servers: readonly McpServerConfig[], enabled?: boolean): void;
}

export interface HarnessOptions {
	servers?: McpServerConfig[];
	http?: Record<string, FakeHttp>;
	/** stdio servers by id, started in the order launches happen. */
	stdio?: FakeServer[];
	desktop?: boolean;
	enabled?: boolean;
	processOptions?: FakeProcessOptions;
}

export function createHarness(options: HarnessOptions = {}): Harness {
	const harness = {
		settings: { ...DEFAULT_MCP_SETTINGS, enabled: options.enabled ?? true, servers: options.servers ?? [] } as McpSettings,
		trust: new MemoryTrustStore(),
		secrets: new Map<string, string>(),
		clock: { now: 1_000_000 },
		logs: [] as string[],
		trustRequests: [] as TrustRequest[],
		cards: [] as ToolApprovalCard[],
		launches: [] as LaunchRequest[],
		processes: [] as FakeProcess[],
		answers: { trust: true, call: "allow-once" } as Harness["answers"]
	};
	let nextStdio = 0;
	const byHost = (url: string): FakeHttp | undefined => {
		const host = new URL(url).hostname.split(".")[0] ?? "";
		return options.http?.[host];
	};
	const host: McpHost = {
		platform: { isDesktopApp: options.desktop ?? true, os: "darwin", env: { PATH: "/usr/bin", HOME: "/Users/me", OPENAI_API_KEY: "sk-do-not-leak-0123456789" } },
		identity: { name: "askmate", version: "1.12.0" },
		settings: () => harness.settings,
		secrets: { get: (id) => harness.secrets.get(id) ?? null },
		deviceTrust: harness.trust,
		requestHttp: (request) => {
			const target = byHost(request.url);
			return target ? target.send(request) : Promise.reject(new Error(`no fake server for ${request.url}`));
		},
		launchProcess: (request) => {
			harness.launches.push(request);
			const server = options.stdio?.[Math.min(nextStdio, (options.stdio?.length ?? 1) - 1)] ?? fakeServer();
			nextStdio += 1;
			const process = fakeProcess(server, options.processOptions);
			harness.processes.push(process);
			return process.child;
		},
		resolveLoginPath: () => Promise.resolve("/opt/homebrew/bin:/usr/bin"),
		confirmTrust: (request) => {
			harness.trustRequests.push(request);
			const answer = harness.answers.trust;
			return Promise.resolve(typeof answer === "function" ? answer() : answer);
		},
		confirmCall: async (card) => {
			harness.cards.push(card);
			const answer = harness.answers.call;
			return typeof answer === "function" ? await answer(card) : answer;
		},
		clock: { now: () => harness.clock.now },
		logger: { warn: (message) => harness.logs.push(`warn: ${message}`), error: (message) => harness.logs.push(`error: ${message}`) },
		tuning: { client: { connectTimeoutMs: 200, listTimeoutMs: 200, callTimeoutMs: 200 }, stdioGraceMs: 5, shutdownDeadlineMs: 300, failedRetryMs: 15_000 }
	};
	return Object.assign(harness, {
		host,
		setServers(servers: readonly McpServerConfig[], enabled?: boolean) {
			harness.settings = { ...harness.settings, servers, enabled: enabled ?? harness.settings.enabled };
		}
	});
}
