import type { McpTransport, TransportReply } from "./transport";
import {
	type ClientIdentity,
	type Era,
	type JsonObject,
	type JsonValue,
	type McpTool,
	type McpToolResult,
	type RequestId,
	LEGACY_VERSIONS,
	MODERN_VERSION,
	McpClientError,
	SUPPORTED_VERSIONS,
	eraOf,
	isJsonObject,
	parseTool,
	parseToolResult
} from "./protocol";
import { cutText } from "./toolPolicy";
import {
	buildHttpHeaders,
	buildRequest,
	extractParamHeaders,
	findReplyOrAnonymousError,
	isToolHeaderSafe,
	judgeHttpProbe,
	judgeStdioProbe,
	parseReplyBody
} from "./wire";

export interface McpClientConfig {
	readonly identity: ClientIdentity;
	readonly connectTimeoutMs: number;
	/**
	 * How long a stdio server of unknown era gets to answer server/discover before AskMate also tries initialize. A legacy server
	 * that ignores unknown methods never answers, and without this it would cost the whole connect timeout. Never longer than it.
	 */
	readonly discoverTimeoutMs: number;
	readonly listTimeoutMs: number;
	readonly callTimeoutMs: number;
	readonly maxPages: number;
	readonly maxTools: number;
	/** A tool whose input schema serialises to more than this is hidden: it would crowd out the user's note in every request. */
	readonly maxSchemaChars: number;
	/** Legacy servers send no ttlMs, so the catalogue is re-read after this long to notice a changed tool list. */
	readonly legacyCatalogueMaxAgeMs: number;
	readonly now: () => number;
}

export const DEFAULT_CLIENT_CONFIG: Omit<McpClientConfig, "identity"> = {
	connectTimeoutMs: 30_000,
	discoverTimeoutMs: 3000,
	listTimeoutMs: 20_000,
	callTimeoutMs: 60_000,
	maxPages: 20,
	maxTools: 500,
	maxSchemaChars: 64 * 1024,
	legacyCatalogueMaxAgeMs: 5 * 60_000,
	now: () => Date.now()
};

export interface ServerSession {
	readonly era: Era;
	readonly version: string;
	readonly serverName: string;
	readonly serverVersion: string;
	readonly instructions: string | null;
	readonly capabilities: JsonObject;
}

/** What an earlier connection to the same server configuration learned. It only saves probes: a wrong hint falls back to full negotiation. */
export interface EraHint {
	readonly era: Era;
	readonly version: string;
}

export interface ToolCatalogue {
	readonly tools: readonly McpTool[];
	readonly fetchedAt: number;
	/** null means "never expires by itself". */
	readonly expiresAt: number | null;
	/** Malformed, duplicate, oversized or header-unsafe tools that were hidden. Surface this in the UI instead of failing the connection. */
	readonly dropped: number;
}

export interface CallToolOptions {
	readonly timeoutMs?: number;
}

const MAX_INPUT_REQUIRED_ROUNDS = 3;
const MAX_TTL_MS = 60 * 60_000;
const MAX_SERVER_MESSAGE_CHARS = 500;
/** Errors that mean "the server is not what we assumed", as opposed to "the server is unreachable". Only these justify a re-probe. */
const REPROBE_KINDS: ReadonlySet<string> = new Set(["protocol", "server_error", "unsupported"]);

class Ids {
	private value = 0;
	next(): number {
		this.value += 1;
		return this.value;
	}
}

function serverInfoOf(result: JsonObject): { name: string; version: string } {
	const meta = isJsonObject(result._meta) ? result._meta : {};
	const info = isJsonObject(meta["io.modelcontextprotocol/serverInfo"]) ? meta["io.modelcontextprotocol/serverInfo"] : isJsonObject(result.serverInfo) ? result.serverInfo : {};
	return {
		name: typeof info.name === "string" ? info.name : "Unnamed server",
		version: typeof info.version === "string" ? info.version : ""
	};
}

function sessionFrom(result: JsonObject, era: Era, version: string): ServerSession {
	const info = serverInfoOf(result);
	return {
		era,
		version,
		serverName: info.name,
		serverVersion: info.version,
		instructions: typeof result.instructions === "string" ? result.instructions : null,
		capabilities: isJsonObject(result.capabilities) ? result.capabilities : {}
	};
}

/** Turns anything that is not a successful JSON-RPC result into one McpClientError the UI can explain. */
function unwrap(reply: TransportReply, id: RequestId): JsonObject {
	if (reply.kind === "rpc") {
		if (reply.reply.kind === "result") {
			return reply.reply.result;
		}
		const { code, message } = reply.reply.error;
		throw new McpClientError("server_error", `The server reported an error (${code}): ${cutText(message, MAX_SERVER_MESSAGE_CHARS)}`, { code });
	}
	const { status, headers, text } = reply.http;
	if (status === 401) {
		throw new McpClientError("auth_required", "The server needs you to sign in or provide a token.", { wwwAuthenticate: headers["www-authenticate"] ?? null });
	}
	if (status === 403) {
		throw new McpClientError("auth_required", "The server refused this token, or it lacks permission for this action.", { wwwAuthenticate: headers["www-authenticate"] ?? null });
	}
	// Servers answer a bad request with a 4xx and a JSON-RPC error body. Show that message instead of a bare status code.
	const found = findReplyOrAnonymousError(parseReplyBody(headers["content-type"] ?? "", text), id);
	if (found?.kind === "error") {
		throw new McpClientError("server_error", `The server reported an error (${found.error.code}): ${cutText(found.error.message, MAX_SERVER_MESSAGE_CHARS)}`, { code: found.error.code });
	}
	if (status >= 200 && status < 300) {
		throw new McpClientError("protocol", `The server's reply could not be read (HTTP ${status}).`);
	}
	throw new McpClientError("transport", `The server answered HTTP ${status}.`);
}

interface CallOptions {
	readonly name?: string;
	readonly extraHeaders?: Readonly<Record<string, string>>;
	/** True for requests with no side effects (discover, list). Only these may be repeated after a lost legacy session. */
	readonly repeatable: boolean;
}

export class McpClient {
	private catalogue: ToolCatalogue | null = null;
	/** Bumped by list_changed. A listing that started before the bump is stored as already stale. */
	private generation = 0;
	private readonly stopListening: () => void;

	private constructor(
		private readonly transport: McpTransport,
		private readonly config: McpClientConfig,
		private readonly ids: Ids,
		private currentSession: ServerSession
	) {
		this.stopListening = transport.onNotification((method) => {
			if (method === "notifications/tools/list_changed") {
				this.invalidate();
			}
		});
	}

	get session(): ServerSession {
		return this.currentSession;
	}

	/** The last listing, even if it has expired. A run uses this so the tools it started with cannot change under it. */
	get currentCatalogue(): ToolCatalogue | null {
		return this.catalogue;
	}

	static async connect(transport: McpTransport, config: McpClientConfig, signal?: AbortSignal, hint?: EraHint): Promise<McpClient> {
		const ids = new Ids();
		const session = await negotiate(transport, config, ids, signal, hint);
		return new McpClient(transport, config, ids, session);
	}

	/** Marks the listing stale so the next listTools() reads it again. The stored listing stays readable for the run that holds it. */
	invalidate(): void {
		this.generation += 1;
		if (this.catalogue) {
			this.catalogue = { ...this.catalogue, expiresAt: this.catalogue.fetchedAt };
		}
	}

	/** One request, with the bounded retry the MRTR pattern allows when a server returns only `requestState`. */
	private async call(method: string, params: JsonObject, timeoutMs: number, signal: AbortSignal | undefined, options: CallOptions): Promise<JsonObject> {
		let state: string | null = null;
		let reinitialised = false;

		for (let round = 0; round < MAX_INPUT_REQUIRED_ROUNDS; round += 1) {
			// Every round is a new request, so a Stop pressed between rounds must end the call before the next one is sent.
			if (signal?.aborted) {
				throw new McpClientError("aborted", "Stopped.");
			}
			const { era, version } = this.currentSession;
			const id = this.ids.next();
			const message = buildRequest(era, id, method, state === null ? params : { ...params, requestState: state }, version, this.config.identity);
			const headers = buildHttpHeaders({ era, version, method, name: options.name, extra: options.extraHeaders });
			const reply = await this.transport.post(message, { headers, timeoutMs, signal });

			if (reply.kind === "http" && reply.http.status === 404 && this.transport.hasSession && !reinitialised) {
				// The server forgot our legacy session and did not run the request. Reconnect so the next request works, but only
				// repeat this one when it has no side effects: a tool call is never sent twice without the user asking.
				reinitialised = true;
				this.transport.resetSession();
				this.currentSession = await negotiate(this.transport, this.config, this.ids, signal, this.currentSession);
				if (!options.repeatable) {
					throw new McpClientError("transport", "The server had ended its session, so this request was not run. AskMate reconnected; ask again to retry it.");
				}
				round -= 1;
				continue;
			}
			const result = unwrap(reply, id);
			if (result.resultType === undefined || result.resultType === "complete") {
				return result;
			}
			if (result.resultType !== "input_required") {
				const shown = typeof result.resultType === "string" ? result.resultType : "(not text)";
				throw new McpClientError("protocol", `The server returned an unknown result type "${cutText(shown, 40)}".`);
			}
			if (isJsonObject(result.inputRequests) && Object.keys(result.inputRequests).length > 0) {
				throw new McpClientError("input_required", "The server asked for extra input that AskMate does not support yet.");
			}
			if (typeof result.requestState !== "string") {
				throw new McpClientError("protocol", "The server asked to retry without saying why.");
			}
			state = result.requestState;
		}
		throw new McpClientError("protocol", "The server kept asking to retry.");
	}

	async listTools(signal?: AbortSignal, force = false): Promise<ToolCatalogue> {
		const cached = this.catalogue;
		if (!force && cached && (cached.expiresAt === null || this.config.now() < cached.expiresAt)) {
			return cached;
		}
		if (!isJsonObject(this.currentSession.capabilities.tools)) {
			return this.store({ tools: [], dropped: 0, ttlMs: null }, this.generation);
		}

		const startedAt = this.generation;
		const accepted = new Map<string, McpTool>();
		let dropped = 0;
		let ttlMs: number | null = null;
		let cursor: string | undefined;

		for (let page = 0; page < this.config.maxPages; page += 1) {
			const result = await this.call("tools/list", cursor === undefined ? {} : { cursor }, this.config.listTimeoutMs, signal, { repeatable: true });
			const rawTools: readonly JsonValue[] = Array.isArray(result.tools) ? result.tools : [];
			for (const raw of rawTools) {
				const tool = parseTool(raw);
				const usable = tool !== null && this.isUsable(tool) && !accepted.has(tool.name) && accepted.size < this.config.maxTools;
				if (tool === null || !usable) {
					dropped += 1;
				} else {
					accepted.set(tool.name, tool);
				}
			}
			if (typeof result.ttlMs === "number" && result.ttlMs >= 0) {
				ttlMs = ttlMs === null ? result.ttlMs : Math.min(ttlMs, result.ttlMs);
			}
			// An empty string is a valid cursor, so only a missing or non-string value ends the walk.
			if (typeof result.nextCursor !== "string") {
				break;
			}
			cursor = result.nextCursor;
		}
		return this.store({ tools: [...accepted.values()], dropped, ttlMs }, startedAt);
	}

	private isUsable(tool: McpTool): boolean {
		const headerSafe = this.transport.kind !== "http" || this.currentSession.era !== "modern" || isToolHeaderSafe(tool);
		return headerSafe && JSON.stringify(tool.inputSchema).length <= this.config.maxSchemaChars;
	}

	private store(input: { tools: McpTool[]; dropped: number; ttlMs: number | null }, startedAt: number): ToolCatalogue {
		const fetchedAt = this.config.now();
		const lifetime = this.currentSession.era === "modern"
			? Math.min(input.ttlMs ?? 0, MAX_TTL_MS)
			: this.config.legacyCatalogueMaxAgeMs;
		// A list_changed that arrived while we were reading means what we read may already be out of date.
		const expiresAt = startedAt === this.generation ? fetchedAt + lifetime : fetchedAt;
		this.catalogue = { tools: input.tools, dropped: input.dropped, fetchedAt, expiresAt };
		return this.catalogue;
	}

	/**
	 * Never retries on transport failure: the call may already have had its side effect. The user decides whether to run it again.
	 * Uses the listing the run started with (listing it first if there is none), so a tool cannot be swapped under an approval.
	 */
	async callTool(name: string, args: JsonObject, signal?: AbortSignal, options: CallToolOptions = {}): Promise<McpToolResult> {
		const catalogue = this.catalogue ?? await this.listTools(signal);
		const tool = catalogue.tools.find((candidate) => candidate.name === name);
		if (!tool) {
			throw new McpClientError("protocol", `The server has no tool called "${name}".`);
		}
		const mirrored = this.transport.kind === "http" && this.currentSession.era === "modern"
			? extractParamHeaders(tool.inputSchema, args)
			: { ok: true as const, headers: {} };
		if (!mirrored.ok) {
			throw new McpClientError("protocol", mirrored.reason);
		}
		const result = await this.call("tools/call", { name, arguments: args }, options.timeoutMs ?? this.config.callTimeoutMs, signal, {
			name,
			extraHeaders: mirrored.headers,
			repeatable: false
		});
		return parseToolResult(result);
	}

	close(): Promise<void> {
		this.stopListening();
		return this.transport.close();
	}
}

async function negotiate(
	transport: McpTransport,
	config: McpClientConfig,
	ids: Ids,
	signal: AbortSignal | undefined,
	hint?: EraHint
): Promise<ServerSession> {
	if (hint?.era === "legacy") {
		// A server we already know speaks the handshake protocol: skip the discover probe, which a silent stdio server would
		// answer only after the whole connect timeout.
		try {
			return await negotiateLegacy(transport, config, ids, signal);
		} catch (error) {
			if (error instanceof McpClientError && REPROBE_KINDS.has(error.kind)) {
				return negotiate(transport, config, ids, signal);
			}
			throw error;
		}
	}
	let version = hint?.era === "modern" ? hint.version : MODERN_VERSION;
	// Only a stdio server of unknown era gets the short window: a known one is just slow, and HTTP silence is a failure anyway.
	const probeMs = transport.kind === "stdio" && hint === undefined ? Math.min(config.discoverTimeoutMs, config.connectTimeoutMs) : config.connectTimeoutMs;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const id = ids.next();
		const message = buildRequest("modern", id, "server/discover", {}, version, config.identity);
		const headers = buildHttpHeaders({ era: "modern", version, method: "server/discover" });
		let reply: TransportReply;
		try {
			reply = await transport.post(message, { headers, timeoutMs: probeMs, signal });
		} catch (error) {
			// Silence from a stdio server is how a legacy server answers an unknown pre-initialize method. Silence over HTTP is just a failure.
			if (error instanceof McpClientError && error.kind === "timeout" && transport.kind === "stdio") {
				return await negotiateAfterSilence(transport, config, ids, signal, version, probeMs < config.connectTimeoutMs);
			}
			throw error;
		}
		const verdict = reply.kind === "http" ? judgeHttpProbe(reply.http, id, SUPPORTED_VERSIONS) : judgeStdioProbe(reply.reply, SUPPORTED_VERSIONS);
		switch (verdict.kind) {
			case "modern":
				return sessionFrom(verdict.result, "modern", version);
			case "retry-with":
				version = verdict.version;
				continue;
			case "legacy":
				return await negotiateLegacy(transport, config, ids, signal);
			case "auth":
				throw new McpClientError("auth_required", "The server needs you to sign in or provide a token.", { wwwAuthenticate: verdict.wwwAuthenticate });
			case "failed":
				throw new McpClientError("protocol", verdict.message);
		}
	}
	throw new McpClientError("protocol", "AskMate and the server could not agree on a protocol version.");
}

/**
 * A stdio server that did not answer server/discover in time is either a legacy server that ignores methods it does not know, or a
 * modern one that is still starting (a package runner may be downloading it). Trying initialize settles the first case. If the
 * server answers that with an error instead, it is up and talking, so it is the second case and discover is asked again, once,
 * with the whole connect budget.
 */
async function negotiateAfterSilence(
	transport: McpTransport,
	config: McpClientConfig,
	ids: Ids,
	signal: AbortSignal | undefined,
	version: string,
	wasShortWindow: boolean
): Promise<ServerSession> {
	try {
		return await negotiateLegacy(transport, config, ids, signal);
	} catch (error) {
		if (wasShortWindow && error instanceof McpClientError && error.kind === "server_error") {
			return negotiate(transport, config, ids, signal, { era: "modern", version });
		}
		throw error;
	}
}

async function negotiateLegacy(transport: McpTransport, config: McpClientConfig, ids: Ids, signal: AbortSignal | undefined): Promise<ServerSession> {
	const offered = LEGACY_VERSIONS[0];
	const id = ids.next();
	const message = buildRequest(
		"legacy",
		id,
		"initialize",
		{ protocolVersion: offered, capabilities: {}, clientInfo: { name: config.identity.name, version: config.identity.version } },
		offered,
		config.identity
	);
	const reply = await transport.post(message, {
		headers: buildHttpHeaders({ era: "legacy", version: offered, method: "initialize" }),
		timeoutMs: config.connectTimeoutMs,
		signal
	});
	if (reply.kind === "http" && reply.http.status === 401) {
		throw new McpClientError("auth_required", "The server needs you to sign in or provide a token.", { wwwAuthenticate: reply.http.headers["www-authenticate"] ?? null });
	}
	if (reply.kind === "http" && [400, 404, 405].includes(reply.http.status)) {
		throw new McpClientError("unsupported", "This server uses the retired HTTP+SSE transport. Ask its author for Streamable HTTP, or run it through a stdio bridge.");
	}
	const result = unwrap(reply, id);
	const negotiated = typeof result.protocolVersion === "string" ? result.protocolVersion : "";
	if (!LEGACY_VERSIONS.includes(negotiated)) {
		throw new McpClientError("unsupported", `The server wants MCP ${cutText(negotiated, 40) || "(unknown)"}, which AskMate cannot speak.`);
	}
	await transport.notify(
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ headers: buildHttpHeaders({ era: "legacy", version: negotiated, method: "notifications/initialized", sessionId: null }), timeoutMs: config.connectTimeoutMs, signal }
	);
	return sessionFrom(result, eraOf(negotiated), negotiated);
}
