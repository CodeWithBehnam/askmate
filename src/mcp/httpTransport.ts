import { NotificationHub, type McpTransport, type NotificationListener, type PostOptions, type TransportReply } from "./transport";
import { type JsonRpcNotification, type JsonRpcRequest, McpClientError } from "./protocol";
import { redactMcpText, stripAuthScheme } from "./redact";
import { findReply, notificationMethods, parseReplyBody } from "./wire";

/** Streamable HTTP over an injected request function. In the plugin that function wraps Obsidian's requestUrl (no CORS, buffered body). */

export interface HttpRequest {
	readonly url: string;
	readonly method: "POST" | "DELETE";
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: string;
}

export interface HttpResponse {
	readonly status: number;
	/** Header names must already be lower-cased. */
	readonly headers: Readonly<Record<string, string>>;
	readonly text: string;
}

export type HttpRequestFn = (request: HttpRequest) => Promise<HttpResponse>;

/** Returns the Authorization header value, read from SecretStorage at send time. Never cached in the transport. */
export type AuthProvider = () => string | null;

/** Returns the user's extra header values (some may be secrets), read at send time. Protocol headers always win over these. */
export type ExtraHeadersProvider = () => Readonly<Record<string, string>>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** How long close() waits for the best-effort DELETE so unloading the plugin cannot hang on a dead network. */
const CLOSE_TIMEOUT_MS = 2000;

/** The one gate for server URLs: https everywhere, plain http only for loopback, no credentials, no fragment. */
export function validateServerUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new McpClientError("unsupported", "That is not a valid URL.");
	}
	const loopback = LOOPBACK.has(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new McpClientError("unsupported", "Use an https:// URL. Plain http:// is only allowed for localhost.");
	}
	if (url.username || url.password) {
		throw new McpClientError("unsupported", "Remove the username and password from the URL and use a bearer token instead.");
	}
	if (url.hash) {
		throw new McpClientError("unsupported", "Remove the #fragment from the URL.");
	}
	return url;
}

function raceWithAbortAndTimeout<T>(work: Promise<T>, options: PostOptions, describe: (message: string) => string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (action: () => void): void => {
			if (!settled) {
				settled = true;
				window.clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				action();
			}
		};
		const onAbort = (): void => finish(() => reject(new McpClientError("aborted", "Stopped.")));
		const timer = window.setTimeout(
			() => finish(() => reject(new McpClientError("timeout", `The server did not answer within ${Math.round(options.timeoutMs / 1000)} seconds.`))),
			options.timeoutMs
		);
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(new McpClientError("transport", describe(error instanceof Error ? error.message : String(error)))))
		);
	});
}

export class HttpTransport implements McpTransport {
	readonly kind = "http" as const;
	private readonly hub = new NotificationHub();
	private sessionId: string | null = null;
	/** The newest MCP-Protocol-Version we sent. Legacy servers expect it on the DELETE that ends a session too. */
	private protocolVersion: string | null = null;

	constructor(
		private readonly url: URL,
		private readonly send: HttpRequestFn,
		private readonly auth: AuthProvider = () => null,
		private readonly extraHeaders: ExtraHeadersProvider = () => ({})
	) {}

	/** Legacy servers (2025-11-25 and earlier) may mint a session on `initialize`; modern servers never do. */
	get hasSession(): boolean {
		return this.sessionId !== null;
	}

	resetSession(): void {
		this.sessionId = null;
	}

	onNotification(listener: NotificationListener): () => void {
		return this.hub.subscribe(listener);
	}

	/** Every secret this transport may hold right now, so any text built from a failure can be masked. */
	private secretValues(): string[] {
		const token = this.auth();
		return [...(token ? [stripAuthScheme(token), token] : []), ...Object.values(this.extraHeaders())];
	}

	private describeFailure(message: string): string {
		return `The connection failed: ${redactMcpText(message, this.secretValues())}`;
	}

	private buildHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
		const token = this.auth();
		return {
			...this.extraHeaders(),
			...headers,
			...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
			...(token ? { Authorization: token } : {})
		};
	}

	private async request(message: JsonRpcRequest | JsonRpcNotification, options: PostOptions): Promise<{ status: number; headers: Readonly<Record<string, string>>; text: string }> {
		// Checked before send(): a request that has already left cannot be recalled, and a stopped tools/call must not run. This
		// matches the stdio transport, which rejects without writing.
		if (options.signal?.aborted) {
			throw new McpClientError("aborted", "Stopped.");
		}
		this.protocolVersion = options.headers["MCP-Protocol-Version"] ?? this.protocolVersion;
		return raceWithAbortAndTimeout(
			this.send({ url: this.url.href, method: "POST", headers: this.buildHeaders(options.headers), body: JSON.stringify(message) }),
			options,
			(text) => this.describeFailure(text)
		);
	}

	async post(message: JsonRpcRequest, options: PostOptions): Promise<TransportReply> {
		const response = await this.request(message, options);
		const session = response.headers["mcp-session-id"];
		if (message.method === "initialize" && session) {
			this.sessionId = session;
		}
		if (response.status >= 200 && response.status < 300) {
			const messages = parseReplyBody(response.headers["content-type"] ?? "", response.text);
			notificationMethods(messages).forEach((method) => this.hub.emit(method));
			const found = findReply(messages, message.id);
			if (found) {
				return { kind: "rpc", reply: found };
			}
		}
		return { kind: "http", http: response };
	}

	async notify(message: JsonRpcNotification, options: PostOptions): Promise<void> {
		const response = await this.request(message, options);
		if (response.status !== 202 && (response.status < 200 || response.status >= 300)) {
			throw new McpClientError("transport", `The server rejected a notification (HTTP ${response.status}).`);
		}
	}

	async close(): Promise<void> {
		const session = this.sessionId;
		this.sessionId = null;
		if (!session) {
			return;
		}
		const token = this.auth();
		// Best effort: a legacy server may answer 405 to say it does not let clients end sessions, and a dead network must not stall unload.
		await raceWithAbortAndTimeout(
			this.send({
				url: this.url.href,
				method: "DELETE",
				headers: { "Mcp-Session-Id": session, ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}), ...(token ? { Authorization: token } : {}) }
			}),
			{ headers: {}, timeoutMs: CLOSE_TIMEOUT_MS },
			(text) => this.describeFailure(text)
		).catch(() => undefined);
	}
}
