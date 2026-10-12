import { feedSse, flushSse, INITIAL_SSE_STATE } from "../providers/sse";
import {
	type ClientIdentity,
	type Era,
	type InboundMessage,
	type JsonObject,
	type JsonRpcRequest,
	type McpTool,
	type RequestId,
	type RpcReply,
	eraOf,
	isJsonObject,
	parseInbound,
	parseJson
} from "./protocol";

/** Pure builders and parsers. Nothing here touches the network, a process or a clock. */

const META = "io.modelcontextprotocol";

/** Modern requests are self-describing. An empty capabilities object declares no elicitation, sampling or roots, so a compliant server never sends input requests. */
export function buildRequest(
	era: Era,
	id: RequestId,
	method: string,
	params: JsonObject,
	version: string,
	client: ClientIdentity
): JsonRpcRequest {
	if (era === "legacy") {
		return { jsonrpc: "2.0", id, method, params };
	}
	const meta = isJsonObject(params._meta) ? params._meta : {};
	return {
		jsonrpc: "2.0",
		id,
		method,
		params: {
			...params,
			_meta: {
				...meta,
				[`${META}/protocolVersion`]: version,
				[`${META}/clientInfo`]: { name: client.name, version: client.version },
				[`${META}/clientCapabilities`]: {}
			}
		}
	};
}

const SENTINEL = /^=\?base64\?.*\?=$/s;
const PLAIN_HEADER_VALUE = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/;

function toBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

/** SEP-2243 value encoding: plain visible ASCII passes through, anything else (and anything that looks like the sentinel) is Base64. */
export function encodeHeaderValue(value: string): string {
	if (value === "") {
		return "";
	}
	return PLAIN_HEADER_VALUE.test(value) && !SENTINEL.test(value) ? value : `=?base64?${toBase64(value)}?=`;
}

export interface HttpHeaderInput {
	readonly era: Era;
	readonly version: string;
	readonly method: string;
	/** `params.name` or `params.uri` for tools/call, prompts/get and resources/read. */
	readonly name?: string;
	readonly sessionId?: string | null;
	readonly extra?: Readonly<Record<string, string>>;
}

/** Authorization is added by the transport at send time so a token never sits in a long-lived object. */
export function buildHttpHeaders(input: HttpHeaderInput): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		...input.extra
	};
	if (input.era === "modern") {
		headers["MCP-Protocol-Version"] = input.version;
		headers["Mcp-Method"] = input.method;
		if (input.name !== undefined) {
			headers["Mcp-Name"] = encodeHeaderValue(input.name);
		}
		return headers;
	}
	if (input.method !== "initialize") {
		headers["MCP-Protocol-Version"] = input.version;
	}
	if (input.sessionId) {
		headers["Mcp-Session-Id"] = input.sessionId;
	}
	return headers;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export type ParamHeaders =
	| { readonly ok: true; readonly headers: Readonly<Record<string, string>> }
	| { readonly ok: false; readonly reason: string };

/**
 * Mirrors `x-mcp-header` tool parameters into `Mcp-Param-*` headers (modern HTTP only). The spec says a tool whose annotation
 * breaks the rules MUST be dropped from tools/list, so a failure here means "hide this tool", not "abort the connection".
 */
export function extractParamHeaders(schema: JsonObject, args: JsonObject): ParamHeaders {
	const headers: Record<string, string> = {};
	const seen = new Set<string>();

	const walk = (node: JsonObject, values: JsonObject | undefined): string | null => {
		const props = node.properties;
		if (!isJsonObject(props)) {
			return null;
		}
		for (const [key, propSchema] of Object.entries(props)) {
			if (!isJsonObject(propSchema)) {
				continue;
			}
			const value = values?.[key];
			const annotation = propSchema["x-mcp-header"];
			if (annotation !== undefined) {
				const name = typeof annotation === "string" ? annotation : "";
				if (!TOKEN.test(name) || seen.has(name.toLowerCase())) {
					return `x-mcp-header "${name}" is empty, not a valid header token or not unique`;
				}
				seen.add(name.toLowerCase());
				const type = propSchema.type;
				if (type !== "string" && type !== "integer" && type !== "boolean") {
					return `x-mcp-header "${name}" is only allowed on string, integer and boolean parameters`;
				}
				if (typeof value === "number" && (!Number.isInteger(value) || Math.abs(value) > SAFE_INTEGER)) {
					return `x-mcp-header "${name}" needs a safe integer`;
				}
				if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
					headers[`Mcp-Param-${name}`] = encodeHeaderValue(String(value));
				}
			}
			const nested = walk(propSchema, isJsonObject(value) ? value : undefined);
			if (nested) {
				return nested;
			}
		}
		return null;
	};

	const problem = walk(schema, args)
		?? (countAnnotations(schema, 0) === seen.size ? null : "x-mcp-header appears where it cannot be reached through plain properties");
	return problem ? { ok: false, reason: problem } : { ok: true, headers };
}

/** Counts every `x-mcp-header` key, wherever it sits, so annotations hidden under items/anyOf/$ref make the tool invalid. Depth-capped against hostile schemas. */
function countAnnotations(node: unknown, depth: number): number {
	if (depth > 32 || typeof node !== "object" || node === null) {
		return 0;
	}
	return Object.entries(node).reduce(
		(total, [key, child]) => total + (key === "x-mcp-header" ? 1 : 0) + countAnnotations(child, depth + 1),
		0
	);
}

export function isToolHeaderSafe(tool: McpTool): boolean {
	return extractParamHeaders(tool.inputSchema, {}).ok;
}

/** Reads every JSON-RPC message out of an HTTP reply body, whether the server answered with JSON or with a (buffered) SSE stream. */
export function parseReplyBody(contentType: string, text: string): InboundMessage[] {
	const toMessages = (values: unknown[]): InboundMessage[] =>
		values.map(parseInbound).filter((message): message is InboundMessage => message !== null);

	if (/text\/event-stream/i.test(contentType)) {
		const fed = feedSse(INITIAL_SSE_STATE, text);
		const events = [...fed.events, ...flushSse(fed.state)];
		return toMessages(events.map((event) => parseJson(event.data)));
	}
	const parsed = parseJson(text);
	return toMessages(Array.isArray(parsed) ? parsed : [parsed]);
}

export function findReply(messages: readonly InboundMessage[], id: RequestId): RpcReply | null {
	return messages.find((message): message is RpcReply => (message.kind === "result" || message.kind === "error") && message.id === id) ?? null;
}

/**
 * Like findReply, but also accepts an error whose id is null. A server that rejects a request before it could read the id (a
 * missing `_meta` key, a malformed header) has to answer with `"id": null`, and that error still belongs to our request.
 */
export function findReplyOrAnonymousError(messages: readonly InboundMessage[], id: RequestId): RpcReply | null {
	return findReply(messages, id) ?? messages.find((message): message is RpcReply => message.kind === "error" && message.id === null) ?? null;
}

/** Methods of the notifications found in a reply body, e.g. `notifications/tools/list_changed`. */
export function notificationMethods(messages: readonly InboundMessage[]): string[] {
	return messages.flatMap((message) => (message.kind === "notification" ? [message.method] : []));
}

export interface HttpReplyLike {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly text: string;
}

export type ProbeVerdict =
	| { readonly kind: "modern"; readonly result: JsonObject }
	| { readonly kind: "retry-with"; readonly version: string }
	| { readonly kind: "legacy" }
	| { readonly kind: "auth"; readonly wwwAuthenticate: string | null }
	| { readonly kind: "failed"; readonly message: string };

const MODERN_ERROR_CODES: readonly number[] = [-32020, -32021, -32022];

/** Highest version both sides know. Returns null when there is no overlap. */
export function pickVersion(serverVersions: readonly string[], ours: readonly string[]): string | null {
	return [...ours].sort().reverse().find((version) => serverVersions.includes(version)) ?? null;
}

/**
 * Decides what a reply to the first modern request means. A 400/404/405 only proves a legacy server when the body is not a
 * recognised modern JSON-RPC error, because modern servers also use those statuses (SEP-2243, unsupported version, unknown method).
 */
export function judgeHttpProbe(reply: HttpReplyLike, id: RequestId, ours: readonly string[]): ProbeVerdict {
	const contentType = reply.headers["content-type"] ?? "";
	const found = findReplyOrAnonymousError(parseReplyBody(contentType, reply.text), id);

	if (reply.status >= 200 && reply.status < 300 && found?.kind === "result") {
		return { kind: "modern", result: found.result };
	}
	if (reply.status === 401) {
		return { kind: "auth", wwwAuthenticate: reply.headers["www-authenticate"] ?? null };
	}
	if (found?.kind === "error" && MODERN_ERROR_CODES.includes(found.error.code)) {
		const supported = isJsonObject(found.error.data) && Array.isArray(found.error.data.supported)
			? found.error.data.supported.filter((value): value is string => typeof value === "string")
			: [];
		const version = pickVersion(supported, ours);
		if (version === null) {
			return { kind: "failed", message: `The server supports MCP ${supported.join(", ") || "no version we know"}, which AskMate cannot use.` };
		}
		return eraOf(version) === "modern" ? { kind: "retry-with", version } : { kind: "legacy" };
	}
	if (found?.kind === "error" && found.error.code === -32601 && reply.status === 404) {
		return { kind: "failed", message: "The server is modern but does not implement server/discover." };
	}
	if ([400, 404, 405].includes(reply.status)) {
		return { kind: "legacy" };
	}
	return { kind: "failed", message: `The server answered HTTP ${reply.status}.` };
}

/** Same decision for stdio, where there are no status codes: only a recognised modern result or error proves a modern server. */
export function judgeStdioProbe(reply: RpcReply, ours: readonly string[]): ProbeVerdict {
	if (reply.kind === "result") {
		return { kind: "modern", result: reply.result };
	}
	if (reply.error.code === -32022) {
		const supported = isJsonObject(reply.error.data) && Array.isArray(reply.error.data.supported)
			? reply.error.data.supported.filter((value): value is string => typeof value === "string")
			: [];
		const version = pickVersion(supported, ours);
		return version !== null && eraOf(version) === "modern" ? { kind: "retry-with", version } : { kind: "legacy" };
	}
	return { kind: "legacy" };
}
