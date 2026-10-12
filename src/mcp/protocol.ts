/** MCP wire types and narrowing helpers. Anything that arrives from a server is `unknown` until it passes through here. */

/** The only revision that drops `initialize`, sessions and `ping`. Lexical comparison works because versions are ISO dates. */
export const MODERN_VERSION = "2026-07-28";
/** Handshake-based revisions AskMate can still talk to, newest first. The retired HTTP+SSE transport (2024-11-05) is not supported. */
export const LEGACY_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const SUPPORTED_VERSIONS: readonly string[] = [MODERN_VERSION, ...LEGACY_VERSIONS];

export type Era = "modern" | "legacy";

export function eraOf(version: string): Era {
	return version >= MODERN_VERSION ? "modern" : "legacy";
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type RequestId = string | number;

export interface ClientIdentity {
	readonly name: string;
	readonly version: string;
}

export interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: RequestId;
	readonly method: string;
	readonly params?: JsonObject;
}

export interface JsonRpcNotification {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly params?: JsonObject;
}

export interface JsonRpcErrorBody {
	readonly code: number;
	readonly message: string;
	readonly data?: JsonValue;
}

/** Messages a server can send, tagged so the rest of the code can switch exhaustively. */
export type InboundMessage =
	| { readonly kind: "result"; readonly id: RequestId; readonly result: JsonObject }
	| { readonly kind: "error"; readonly id: RequestId | null; readonly error: JsonRpcErrorBody }
	| { readonly kind: "notification"; readonly method: string; readonly params: JsonObject }
	| { readonly kind: "request"; readonly id: RequestId; readonly method: string };

export type RpcReply = Extract<InboundMessage, { kind: "result" | "error" }>;

/** Error codes the 2026-07-28 revision reserves, plus the JSON-RPC ones the client branches on. */
export const RPC_CODE = {
	methodNotFound: -32601,
	invalidParams: -32602,
	headerMismatch: -32020,
	missingClientCapability: -32021,
	unsupportedProtocolVersion: -32022
} as const;

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
	return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Parses JSON text at the trust boundary. Returns undefined instead of throwing so callers decide what a bad body means. */
export function parseJson(text: string): JsonValue | undefined {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

export function parseInbound(raw: unknown): InboundMessage | null {
	if (!isJsonObject(raw) || raw.jsonrpc !== "2.0") {
		return null;
	}
	const { id, method, result, error, params } = raw;
	if (typeof method === "string") {
		if (id === undefined) {
			return { kind: "notification", method, params: isJsonObject(params) ? params : {} };
		}
		return isRequestId(id) ? { kind: "request", id, method } : null;
	}
	if (isJsonObject(error) && typeof error.code === "number" && typeof error.message === "string") {
		const body: JsonRpcErrorBody = error.data === undefined
			? { code: error.code, message: error.message }
			: { code: error.code, message: error.message, data: error.data };
		return { kind: "error", id: isRequestId(id) ? id : null, error: body };
	}
	if (isRequestId(id) && isJsonObject(result)) {
		return { kind: "result", id, result };
	}
	return null;
}

export interface McpToolAnnotations {
	readonly title?: string;
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
	readonly idempotentHint?: boolean;
	readonly openWorldHint?: boolean;
}

export interface McpTool {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
	readonly inputSchema: JsonObject;
	readonly outputSchema?: JsonObject;
	/** Untrusted unless the user explicitly trusts the server: a hostile server can claim readOnlyHint for anything. */
	readonly annotations?: McpToolAnnotations;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function parseTool(raw: unknown): McpTool | null {
	if (!isJsonObject(raw) || typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 128) {
		return null;
	}
	const a = isJsonObject(raw.annotations) ? raw.annotations : null;
	const annotations: McpToolAnnotations | undefined = a
		? {
			title: optionalString(a.title),
			readOnlyHint: optionalBoolean(a.readOnlyHint),
			destructiveHint: optionalBoolean(a.destructiveHint),
			idempotentHint: optionalBoolean(a.idempotentHint),
			openWorldHint: optionalBoolean(a.openWorldHint)
		}
		: undefined;
	return {
		name: raw.name,
		title: optionalString(raw.title),
		description: optionalString(raw.description),
		inputSchema: isJsonObject(raw.inputSchema) ? raw.inputSchema : { type: "object" },
		outputSchema: isJsonObject(raw.outputSchema) ? raw.outputSchema : undefined,
		annotations
	};
}

export type McpContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image" | "audio"; readonly mimeType: string; readonly bytes: number }
	| { readonly type: "resource_link"; readonly uri: string; readonly name: string }
	| { readonly type: "resource"; readonly uri: string; readonly text?: string }
	| { readonly type: "unknown"; readonly originalType: string };

export interface McpToolResult {
	readonly content: readonly McpContent[];
	readonly isError: boolean;
	readonly structuredContent?: JsonValue;
}

function parseContent(raw: unknown): McpContent {
	if (!isJsonObject(raw) || typeof raw.type !== "string") {
		return { type: "unknown", originalType: "malformed" };
	}
	switch (raw.type) {
		case "text":
			return typeof raw.text === "string" ? { type: "text", text: raw.text } : { type: "unknown", originalType: "text" };
		case "image":
		case "audio":
			return {
				type: raw.type,
				mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "application/octet-stream",
				bytes: typeof raw.data === "string" ? Math.floor(raw.data.length * 0.75) : 0
			};
		case "resource_link":
			return typeof raw.uri === "string"
				? { type: "resource_link", uri: raw.uri, name: typeof raw.name === "string" ? raw.name : raw.uri }
				: { type: "unknown", originalType: "resource_link" };
		case "resource": {
			const resource = raw.resource;
			return isJsonObject(resource) && typeof resource.uri === "string"
				? { type: "resource", uri: resource.uri, text: optionalString(resource.text) }
				: { type: "unknown", originalType: "resource" };
		}
		default:
			return { type: "unknown", originalType: raw.type };
	}
}

export function parseToolResult(result: JsonObject): McpToolResult {
	const content = Array.isArray(result.content) ? result.content.map(parseContent) : [];
	return {
		content,
		isError: result.isError === true,
		structuredContent: result.structuredContent
	};
}

export type McpErrorKind =
	| "timeout"
	| "aborted"
	| "transport"
	| "protocol"
	| "auth_required"
	| "input_required"
	| "server_error"
	| "unsupported";

/** One error type for every failure the UI has to explain. `kind` drives the wording and whether Retry is offered. */
export class McpClientError extends Error {
	constructor(readonly kind: McpErrorKind, message: string, readonly detail?: JsonValue) {
		super(message);
		this.name = "McpClientError";
	}
}
