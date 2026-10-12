import { type JsonObject, type JsonValue, type McpTool, type McpToolResult, isJsonObject } from "./protocol";
import { sha256Hex } from "./sha256";

/** Pure safety policy: naming, change detection, approval decisions and how tool output is presented to the model. */

export interface ToolRef {
	readonly serverId: string;
	readonly toolName: string;
}

const MODEL_NAME_LIMIT = 64;
/** "_" plus a six character hash. */
const HASH_SUFFIX_LENGTH = 7;

function shortHash(text: string): string {
	let hash = 5381;
	for (let index = 0; index < text.length; index += 1) {
		hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
	}
	return hash.toString(36).padStart(6, "0").slice(-6);
}

function cleanedName(ref: ToolRef): string {
	// Hyphens are cleaned too: the tool layer only accepts [A-Za-z_][A-Za-z0-9_]{0,63}, the alphabet every provider accepts.
	const clean = `${ref.serverId}__${ref.toolName}`.replace(/[^A-Za-z0-9_]/g, "_");
	// Gemini requires a letter or underscore first, and every provider accepts that.
	return /^[A-Za-z_]/.test(clean) ? clean : `_${clean}`;
}

function withHash(base: string, discriminator: string): string {
	return `${base.slice(0, MODEL_NAME_LIMIT - HASH_SUFFIX_LENGTH)}_${shortHash(discriminator)}`;
}

/**
 * Every generated name matches /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, the strictest function-name alphabet across providers, so the
 * tool layer can use it as is. MCP itself allows dots, hyphens and 128 characters, so those are replaced with underscores.
 * The mapping is rebuilt per run from the live catalogue and is the only way a model-chosen name reaches a server.
 *
 * Naming does not depend on the order of the input. A tool whose own name needs no cleaning keeps the plain name; every other tool
 * that would collide with it, or that is too long, gets a hash of its server and tool name. A final pass guarantees uniqueness.
 */
export function buildModelToolNames(tools: readonly ToolRef[]): ReadonlyMap<string, ToolRef> {
	interface Candidate {
		readonly ref: ToolRef;
		readonly base: string;
		readonly raw: string;
		/** True when the name needed no cleaning, so the model sees exactly what the server calls it (plus the server prefix). */
		readonly exact: boolean;
	}
	const sorted = [...tools].sort((a, b) => {
		const left = `${a.serverId}\0${a.toolName}`;
		const right = `${b.serverId}\0${b.toolName}`;
		return left < right ? -1 : left > right ? 1 : 0;
	});
	const candidates: Candidate[] = sorted.map((ref) => {
		const base = cleanedName(ref);
		return { ref, base, raw: `${ref.serverId}/${ref.toolName}`, exact: `${ref.serverId}__${ref.toolName}` === base };
	});
	const groups = candidates.reduce((byBase, candidate) => byBase.set(candidate.base, [...(byBase.get(candidate.base) ?? []), candidate]), new Map<string, Candidate[]>());
	// One candidate per base may keep the plain name: the only member, or else the first one that needed no cleaning.
	const owners = new Set<Candidate>(
		[...groups.entries()].flatMap(([base, members]) => {
			const owner = base.length > MODEL_NAME_LIMIT ? undefined : members.length === 1 ? members[0] : members.find((member) => member.exact);
			return owner ? [owner] : [];
		})
	);

	const names = new Map<string, ToolRef>();
	for (const candidate of candidates) {
		let name = owners.has(candidate) ? candidate.base : withHash(candidate.base, candidate.raw);
		// A hash collision is astronomically unlikely, but a silent overwrite would send a call to the wrong tool.
		for (let attempt = 1; names.has(name); attempt += 1) {
			name = withHash(candidate.base, `${candidate.raw}#${attempt}`);
		}
		names.set(name, candidate.ref);
	}
	return names;
}

function canonical(value: JsonValue | undefined): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value)
			.filter((entry): entry is [string, JsonValue] => entry[1] !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

/** Key-order independent JSON text. Used for fingerprints and trust hashes so equal data always hashes equally. */
export function canonicalJson(value: JsonValue | undefined): string {
	return canonical(value);
}

/**
 * SHA-256 over everything a model or a person can read about a tool. A changed value means the user approved something else
 * (a rug pull), so the next call needs a fresh approval.
 */
export function fingerprintTool(tool: McpTool): string {
	const material = canonical({
		name: tool.name,
		title: tool.title ?? null,
		description: tool.description ?? null,
		inputSchema: tool.inputSchema,
		outputSchema: tool.outputSchema ?? null,
		annotations: tool.annotations ? { ...tool.annotations } : null
	});
	return sha256Hex(material);
}

export type ApprovalMode = "always-ask" | "ask-once-per-chat" | "trusted-read-only";

export const APPROVAL_MODES: readonly ApprovalMode[] = ["always-ask", "ask-once-per-chat", "trusted-read-only"];

export function isApprovalMode(value: unknown): value is ApprovalMode {
	return APPROVAL_MODES.some((mode) => mode === value);
}

export interface Grant {
	readonly fingerprint: string;
	/** "chat" lives in memory for one conversation. "always" is only ever created by an explicit, persisted user choice. */
	readonly scope: "chat" | "always";
}

export type ApprovalDecision =
	| { readonly kind: "allow" }
	| { readonly kind: "ask"; readonly reason: "first-use" | "changed" | "mode" | "possible-side-effect" };

export interface ApprovalInput {
	readonly mode: ApprovalMode;
	readonly tool: Pick<McpTool, "annotations">;
	readonly fingerprint: string;
	readonly grant: Grant | undefined;
	/** The user switched "trust this server's read-only hints" on. Annotations are otherwise ignored for safety decisions. */
	readonly trustsAnnotations: boolean;
}

/**
 * The approval decision table, first match wins:
 *
 * 1. A grant for a different fingerprint: ask ("changed"), whatever the mode.
 * 2. Mode "trusted-read-only" on a server whose annotations are trusted, and the tool claims readOnlyHint without destructiveHint: allow.
 * 3. A chat grant for this fingerprint: allow. The user chose "Allow for this chat" deliberately, so it applies in every mode.
 * 4. Mode "always-ask": ask ("mode"). A persistent grant never bypasses it.
 * 5. A grant for this fingerprint: allow (modes "ask-once-per-chat" and "trusted-read-only").
 * 6. Mode "trusted-read-only" with trusted annotations, but the tool does not claim to be read only: ask ("possible-side-effect").
 * 7. Otherwise: ask ("first-use").
 */
export function decideApproval(input: ApprovalInput): ApprovalDecision {
	const { mode, tool, fingerprint, grant, trustsAnnotations } = input;
	if (grant && grant.fingerprint !== fingerprint) {
		return { kind: "ask", reason: "changed" };
	}
	const claimsReadOnly = tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
	if (mode === "trusted-read-only" && trustsAnnotations && claimsReadOnly) {
		return { kind: "allow" };
	}
	if (grant?.scope === "chat") {
		return { kind: "allow" };
	}
	if (mode === "always-ask") {
		return { kind: "ask", reason: "mode" };
	}
	if (grant) {
		return { kind: "allow" };
	}
	return mode === "trusted-read-only" && trustsAnnotations ? { kind: "ask", reason: "possible-side-effect" } : { kind: "ask", reason: "first-use" };
}

/**
 * Code point ranges that render as nothing or change how text reads: control characters (tab, newline and carriage return stay),
 * soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and bidi characters, the byte-order mark, Unicode "tag"
 * characters (used to smuggle invisible ASCII) and supplementary variation selectors. Ranges instead of a regex keep the lint
 * quiet about combining characters and make the list easy to read.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x0000, 0x0008], [0x000b, 0x000c], [0x000e, 0x001f], [0x007f, 0x007f], [0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e],
	[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff], [0xe0000, 0xe007f], [0xe0100, 0xe01ef]
];

function isInvisible(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? 0;
	return INVISIBLE_RANGES.some(([first, last]) => codePoint >= first && codePoint <= last);
}

function hasInvisible(text: string): boolean {
	return Array.from(text).some(isInvisible);
}

const SUSPICIOUS: ReadonlyArray<readonly [RegExp, string]> = [
	[/<\s*(important|system|instructions?)\b/i, "contains a hidden-instruction tag"],
	[/ignore (all |any )?(previous|prior|above)/i, "tells the model to ignore earlier instructions"],
	[/(~|\/home\/[^/\s]+|\/Users\/[^/\s]+)\/\.(ssh|aws|gnupg|config)/i, "mentions a private credentials folder"],
	[/do not (tell|mention|show|reveal)[^.]{0,40}(user|human)/i, "asks the model to hide something from you"],
	[/<\s*\/?\s*(tool_result|user_request|note_context|context_attachment|evidence_sources)\b/i, "contains AskMate's own prompt tags"]
];

/** Cuts at a character count without splitting a surrogate pair. */
export function cutText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	const lastKept = text.charCodeAt(maxChars - 1);
	const end = lastKept >= 0xd800 && lastKept <= 0xdbff ? maxChars - 1 : maxChars;
	return text.slice(0, end);
}

export function stripInvisible(text: string): string {
	return Array.from(text).filter((character) => !isInvisible(character)).join("");
}

/** What the model is shown. The approval dialog shows the original with invisible characters made visible, so nothing is hidden from the user. */
export function sanitiseDescription(description: string | undefined, maxChars = 1024): string {
	const clean = stripInvisible(description ?? "").trim();
	return clean.length <= maxChars ? clean : `${cutText(clean, maxChars)}...`;
}

/** One-line names and titles for chips, cards and tag attributes. */
export function sanitiseDisplayName(name: string, maxChars = 120): string {
	return cutText(stripInvisible(name).replace(/\s+/g, " ").trim(), maxChars);
}

/** Replaces each invisible character with a visible `[U+200B]` marker, for the review view of an untrusted description. */
export function revealInvisible(text: string, maxChars = 4000): string {
	const marker = (character: string): string => `[U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}]`;
	const shown = Array.from(text, (character) => (isInvisible(character) ? marker(character) : character)).join("");
	return shown.length <= maxChars ? shown : `${cutText(shown, maxChars)}...`;
}

/** Heuristic warnings only. They raise a flag for the user and never replace approval. */
export function findDescriptionWarnings(description: string | undefined): string[] {
	const raw = description ?? "";
	return [
		...(hasInvisible(raw) ? ["contains invisible characters"] : []),
		...SUSPICIOUS.filter(([pattern]) => pattern.test(raw)).map(([, label]) => label)
	];
}

const SCHEMA_MAX_DEPTH = 32;
const SCHEMA_TEXT_FIELDS = new Set(["description", "title"]);

/**
 * Copies an input schema for the model with invisible characters removed from every string and `description` / `title` capped.
 * Parameter descriptions are a known place to hide instructions ("full-schema poisoning"), so they get the same treatment as the
 * tool description. The original schema still feeds the fingerprint.
 */
export function sanitiseSchema(schema: JsonObject, maxTextChars = 1024): JsonObject {
	const clean = (value: JsonValue, depth: number, key: string | null): JsonValue => {
		if (typeof value === "string") {
			const stripped = stripInvisible(value);
			return key !== null && SCHEMA_TEXT_FIELDS.has(key) ? sanitiseDescription(stripped, maxTextChars) : stripped;
		}
		if (value === null || typeof value !== "object") {
			return value;
		}
		if (depth >= SCHEMA_MAX_DEPTH) {
			return null;
		}
		if (Array.isArray(value)) {
			return value.map((item) => clean(item, depth + 1, null));
		}
		return Object.fromEntries(Object.entries(value).map(([name, child]) => [stripInvisible(name), clean(child, depth + 1, name)]));
	};
	const cleaned = clean(schema, 0, null);
	return isJsonObject(cleaned) ? cleaned : { type: "object" };
}

/** Every string in a schema (keys and values), joined, so the description heuristics can run over parameter text too. */
export function collectSchemaText(schema: JsonValue, limit = 20000): string {
	const parts: string[] = [];
	let size = 0;
	const visit = (value: JsonValue, depth: number): void => {
		if (size >= limit || depth > SCHEMA_MAX_DEPTH) {
			return;
		}
		if (typeof value === "string") {
			parts.push(value);
			size += value.length;
		} else if (Array.isArray(value)) {
			value.forEach((item) => visit(item, depth + 1));
		} else if (value !== null && typeof value === "object") {
			Object.entries(value).forEach(([key, child]) => {
				parts.push(key);
				size += key.length;
				visit(child, depth + 1);
			});
		}
	};
	visit(schema, 0);
	return parts.join("\n");
}

export function findSchemaWarnings(schema: JsonObject): string[] {
	return findDescriptionWarnings(collectSchemaText(schema)).map((warning) => `input schema ${warning}`);
}

export interface OutputLimits {
	readonly maxChars: number;
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = { maxChars: 20_000 };

/** Tags AskMate wraps prompt sections in. Tool output must never be able to open or close one. */
const DELIMITER_TAGS = [
	"tool_result",
	"note_context",
	"context_attachment",
	"evidence_sources",
	"user_request",
	"image_request",
	"skill",
	"skill_context",
	"active_skills"
] as const;
const DELIMITER_PATTERN = new RegExp(`<(\\s*/?\\s*)(${DELIMITER_TAGS.join("|")})`, "gi");

function escapeToolDelimiters(text: string): string {
	return text.replace(DELIMITER_PATTERN, "&lt;$1$2");
}

function attribute(value: string): string {
	return sanitiseDisplayName(value, 80).replace(/"/g, "'").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function open(serverLabel: string, toolName: string, status: string, trust: string): string {
	return `<tool_result server="${attribute(serverLabel)}" tool="${attribute(toolName)}" status="${status}" trust="${trust}">`;
}

/** Flattens a result to bounded text and fences it as untrusted data. Binary content is described, never forwarded. */
export function renderToolResult(serverLabel: string, toolName: string, result: McpToolResult, limits: OutputLimits = DEFAULT_OUTPUT_LIMITS): string {
	const parts = result.content.map((block) => {
		switch (block.type) {
			case "text":
				return block.text;
			case "resource":
				return block.text ?? `[Embedded resource ${block.uri} without text]`;
			case "resource_link":
				return `[Link to resource ${block.name}: ${block.uri}]`;
			case "image":
			case "audio":
				return `[${block.type} of ${block.bytes} bytes (${block.mimeType}) not shown to the model]`;
			case "unknown":
				return `[Unsupported content of type ${block.originalType}]`;
		}
	});
	const structured = parts.length === 0 && result.structuredContent !== undefined ? [canonical(result.structuredContent)] : [];
	const joined = stripInvisible([...parts, ...structured].join("\n")).trim() || "(The tool returned no content.)";
	const bounded = joined.length > limits.maxChars
		? `${cutText(joined, limits.maxChars)}\n[Output cut after ${limits.maxChars} characters.]`
		: joined;
	return `${open(serverLabel, toolName, result.isError ? "error" : "ok", "untrusted")}\n${escapeToolDelimiters(bounded)}\n</tool_result>`;
}

export type HostNoticeStatus = "denied" | "error" | "stopped";

/** A result written by AskMate itself (a denial, a failure, a stop) in the same shape as a server result, so the model sees one format. */
export function renderHostNotice(serverLabel: string, toolName: string, status: HostNoticeStatus, message: string): string {
	return `${open(serverLabel, toolName, status, "host")}\n${escapeToolDelimiters(stripInvisible(message))}\n</tool_result>`;
}
