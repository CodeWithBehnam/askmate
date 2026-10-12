import { McpClientError } from "./protocol";
import { validateServerUrl } from "./httpTransport";
import { sha256Hex } from "./sha256";
import { type ApprovalMode, canonicalJson, isApprovalMode } from "./toolPolicy";

/**
 * Server definitions as they are stored in data.json under `mcp`, and the checks that run before one is used.
 * Secret values never appear here: an entry holds the id of a SecretStorage secret instead.
 */

/** A plain value is visible configuration. A secret value is a reference, resolved from SecretStorage when it is needed. */
export type McpValue =
	| { readonly kind: "plain"; readonly value: string }
	| { readonly kind: "secret"; readonly secretId: string };

export interface McpServerBase {
	/** Lower-case letters, digits and dashes. Used in model-facing tool names and in secret ids. */
	readonly id: string;
	readonly label: string;
	readonly enabled: boolean;
	readonly approval: ApprovalMode;
	/** Believe this server's readOnlyHint when the approval mode is "trusted-read-only". Annotations are otherwise untrusted. */
	readonly trustsAnnotations: boolean;
	readonly callTimeoutMs?: number;
	/** Tool names the user turned off. They never reach the model. */
	readonly disabledTools?: readonly string[];
}

export interface McpStdioServerConfig extends McpServerBase {
	readonly transport: "stdio";
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, McpValue>>;
}

export interface McpHttpServerConfig extends McpServerBase {
	readonly transport: "http";
	readonly url: string;
	readonly headers: Readonly<Record<string, McpValue>>;
	/** SecretStorage id of the bearer token, or null for a server that needs none. */
	readonly bearerSecretId: string | null;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpSettings {
	/** Master switch. MCP is off until the user turns it on. */
	readonly enabled: boolean;
	readonly servers: readonly McpServerConfig[];
	/** Hard stop for tool rounds in one answer. Consumed by the tool loop. */
	readonly maxToolRoundsPerTurn: number;
	/** Character cap for one tool result before it is shown to the model. */
	readonly maxOutputChars: number;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
	enabled: false,
	servers: [],
	maxToolRoundsPerTurn: 5,
	maxOutputChars: 20_000
};

export const MAX_SERVERS = 50;
const MAX_ARGS = 100;
const MAX_ARG_CHARS = 4096;
const MAX_ENTRIES = 50;
const MAX_LABEL_CHARS = 60;

const SERVER_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** SecretStorage ids are lower-case alphanumerics with optional dashes. */
const SECRET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Headers AskMate sets itself. A user entry for one of these could break the protocol or smuggle a request. */
const RESERVED_HEADERS = /^(?:host|content-length|content-type|accept|connection|transfer-encoding|upgrade|te|trailer|expect|cookie|origin|referer|user-agent|mcp-.*)$/i;

export function isValidServerId(id: string): boolean {
	return SERVER_ID.test(id);
}

export function isValidSecretId(id: string): boolean {
	return SECRET_ID.test(id) && id.length <= 120;
}

export function isValidHeaderName(name: string): boolean {
	return HEADER_NAME.test(name) && !RESERVED_HEADERS.test(name);
}

/** Header values go on the wire, so a CR or LF would let a value inject a second header. */
function isValidHeaderValue(value: string): boolean {
	return !/[\0\r\n]/.test(value);
}

/** Every secret AskMate creates for an MCP server lives under this prefix. */
export const MCP_SECRET_PREFIX = "askmate-mcp-";

/** The secret id a server's own secret gets, e.g. `askmate-mcp-github-token`. */
export function secretIdFor(serverId: string, name: string): string {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "secret";
	return `${MCP_SECRET_PREFIX}${serverId}-${slug}`;
}

/** One place a definition reads a stored secret from, as the trust dialog lists it. */
export interface SecretUse {
	/** Plain words for the dialog, e.g. `The bearer token` or `The header "X-Key"`. */
	readonly where: string;
	readonly secretId: string;
}

/** The stored secrets a definition would hand to its server, in a fixed order. Display only: no value is read. */
export function listSecretUses(server: McpServerConfig): SecretUse[] {
	const fromValues = (kind: string, values: Readonly<Record<string, McpValue>>): SecretUse[] =>
		Object.keys(values).flatMap((name) => {
			const value = values[name];
			return value.kind === "secret" ? [{ where: `The ${kind} "${name}"`, secretId: value.secretId }] : [];
		});
	return server.transport === "stdio"
		? fromValues("variable", server.env)
		: [...(server.bearerSecretId === null ? [] : [{ where: "The bearer token", secretId: server.bearerSecretId }]), ...fromValues("header", server.headers)];
}

/**
 * Advisory warnings for secrets that were not made for this server. A synced or hand-edited data.json can point a definition at any
 * SecretStorage id, for example the provider API key, and the trust dialog is the only place the person can notice it.
 */
export function findSecretRisks(server: McpServerConfig, recipient: string): string[] {
	const own = `${MCP_SECRET_PREFIX}${server.id}-`;
	return listSecretUses(server).flatMap(({ where, secretId }): string[] => {
		if (!secretId.startsWith(MCP_SECRET_PREFIX)) {
			return [`${where} uses the stored secret "${secretId}", which AskMate did not create for MCP. It could be your AI provider key or another plugin's token, and it would be sent to ${recipient}.`];
		}
		return secretId.startsWith(own) ? [] : [`${where} uses the stored secret "${secretId}", which belongs to a different MCP server, and it would be sent to ${recipient}.`];
	});
}

export function slugifyServerId(label: string, taken: ReadonlySet<string>): string {
	const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
	const seeded = /^[a-z]/.test(base) ? base : `server-${base}`.replace(/-$/, "");
	const root = seeded || "server";
	let candidate = root;
	for (let n = 2; taken.has(candidate); n += 1) {
		candidate = `${root.slice(0, 36)}-${n}`;
	}
	return candidate;
}

function checkValues(
	kind: string,
	values: Readonly<Record<string, McpValue>>,
	nameOk: (name: string) => boolean,
	plainValueOk: (value: string) => boolean,
	problems: string[]
): void {
	const names = Object.keys(values);
	if (names.length > MAX_ENTRIES) {
		problems.push(`Too many ${kind} entries (the limit is ${MAX_ENTRIES}).`);
	}
	for (const name of names) {
		const value = values[name];
		if (!nameOk(name)) {
			problems.push(`"${name}" is not an allowed ${kind} name.`);
		} else if (value.kind === "secret" ? !isValidSecretId(value.secretId) : !plainValueOk(value.value)) {
			problems.push(`The value of ${kind} "${name}" is not valid.`);
		}
	}
}

/** Human-readable problems with a definition. Empty means it may be used. Never throws, so a corrupt entry cannot break the settings page. */
export function validateServerConfig(server: McpServerConfig): string[] {
	const problems: string[] = [];
	if (!isValidServerId(server.id)) {
		problems.push("The server id must be lower-case letters, digits and dashes, starting with a letter.");
	}
	if (!server.label.trim() || server.label.length > MAX_LABEL_CHARS) {
		problems.push(`The server name must be 1 to ${MAX_LABEL_CHARS} characters.`);
	}
	if (!isApprovalMode(server.approval)) {
		problems.push("The approval mode is not recognised.");
	}
	if (server.transport === "stdio") {
		if (!server.command.trim() || /[\0\r\n]/.test(server.command)) {
			problems.push("The command is empty or contains a control character.");
		}
		if (server.args.length > MAX_ARGS || server.args.some((arg) => arg.length > MAX_ARG_CHARS || arg.includes("\0"))) {
			problems.push("The arguments are too many, too long or contain a NUL character.");
		}
		checkValues("environment variable", server.env, (name) => ENV_NAME.test(name), (value) => !value.includes("\0"), problems);
	} else {
		try {
			validateServerUrl(server.url);
		} catch (error) {
			problems.push(error instanceof McpClientError ? error.message : "The URL is not valid.");
		}
		if (server.bearerSecretId !== null && !isValidSecretId(server.bearerSecretId)) {
			problems.push("The bearer token reference is not valid.");
		}
		checkValues("header", server.headers, isValidHeaderName, isValidHeaderValue, problems);
	}
	return problems;
}

/**
 * Everything that decides what running or contacting this server does, in a fixed order. Plain values are included in full
 * because a changed NODE_OPTIONS or URL is a different server. Secret values are never read here, only their ids.
 */
export function trustMaterial(server: McpServerConfig): string {
	const valueOf = (value: McpValue): string => (value.kind === "plain" ? `plain:${value.value}` : `secret:${value.secretId}`);
	const entries = (values: Readonly<Record<string, McpValue>>): Array<[string, string]> =>
		Object.keys(values).sort().map((name) => [name, valueOf(values[name])]);
	return canonicalJson(
		server.transport === "stdio"
			? { transport: "stdio", command: server.command, args: [...server.args], env: entries(server.env) }
			: { transport: "http", url: server.url, bearer: server.bearerSecretId, headers: entries(server.headers) }
	);
}

/** The device-local trust record for a definition. Any change to the command, arguments, environment, URL or headers changes it. */
export function trustHash(server: McpServerConfig): string {
	return sha256Hex(trustMaterial(server));
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseValues(raw: unknown): Record<string, McpValue> {
	if (!isRecord(raw)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(raw).flatMap(([name, value]): Array<[string, McpValue]> => {
			if (typeof value === "string") {
				return [[name, { kind: "plain", value }]];
			}
			if (isRecord(value) && value.kind === "secret" && typeof value.secretId === "string") {
				return [[name, { kind: "secret", secretId: value.secretId }]];
			}
			if (isRecord(value) && value.kind === "plain" && typeof value.value === "string") {
				return [[name, { kind: "plain", value: value.value }]];
			}
			return [];
		})
	);
}

function stringList(raw: unknown, limit: number, maxChars: number): string[] {
	return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string" && item.length <= maxChars).slice(0, limit) : [];
}

function normaliseServer(raw: unknown, taken: ReadonlySet<string>): McpServerConfig | null {
	if (!isRecord(raw) || (raw.transport !== "stdio" && raw.transport !== "http")) {
		return null;
	}
	const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, MAX_LABEL_CHARS) : null;
	const storedId = typeof raw.id === "string" && isValidServerId(raw.id) && !taken.has(raw.id) ? raw.id : null;
	const id = storedId ?? slugifyServerId(label ?? "server", taken);
	const timeout = typeof raw.callTimeoutMs === "number" && Number.isFinite(raw.callTimeoutMs) ? Math.min(Math.max(Math.round(raw.callTimeoutMs), 1_000), 600_000) : undefined;
	const disabledTools = [...new Set(stringList(raw.disabledTools, 500, 128))];
	const base = {
		id,
		label: label ?? id,
		// A definition that does not say it is enabled is not.
		enabled: raw.enabled === true,
		approval: isApprovalMode(raw.approval) ? raw.approval : "always-ask" as const,
		trustsAnnotations: raw.trustsAnnotations === true,
		...(timeout === undefined ? {} : { callTimeoutMs: timeout }),
		...(disabledTools.length > 0 ? { disabledTools } : {})
	};
	if (raw.transport === "stdio") {
		return typeof raw.command === "string"
			? { ...base, transport: "stdio", command: raw.command, args: stringList(raw.args, MAX_ARGS, MAX_ARG_CHARS), env: normaliseValues(raw.env) }
			: null;
	}
	return typeof raw.url === "string"
		? {
			...base,
			transport: "http",
			url: raw.url,
			headers: normaliseValues(raw.headers),
			bearerSecretId: typeof raw.bearerSecretId === "string" && raw.bearerSecretId ? raw.bearerSecretId : null
		}
		: null;
}

function clampedInteger(raw: unknown, fallback: number, min: number, max: number): number {
	return typeof raw === "number" && Number.isFinite(raw) ? Math.min(Math.max(Math.round(raw), min), max) : fallback;
}

/**
 * Reads the `mcp` group of data.json. Keeps only known fields (so a token pasted into a definition by hand is dropped rather than
 * kept), fills defaults, gives duplicate or missing ids a fresh one, and keeps MCP off unless the file says `enabled: true`.
 * Definitions that are well formed but not usable (an http:// URL, say) are kept so the settings page can show what is wrong;
 * McpService refuses to run them. Safe to call on its own output.
 */
export function normalizeMcpSettings(raw: unknown): McpSettings {
	if (!isRecord(raw)) {
		return DEFAULT_MCP_SETTINGS;
	}
	const servers: McpServerConfig[] = [];
	const taken = new Set<string>();
	for (const entry of Array.isArray(raw.servers) ? raw.servers : []) {
		const server = servers.length < MAX_SERVERS ? normaliseServer(entry, taken) : null;
		if (server) {
			taken.add(server.id);
			servers.push(server);
		}
	}
	return {
		enabled: raw.enabled === true,
		servers,
		maxToolRoundsPerTurn: clampedInteger(raw.maxToolRoundsPerTurn, DEFAULT_MCP_SETTINGS.maxToolRoundsPerTurn, 1, 12),
		maxOutputChars: clampedInteger(raw.maxOutputChars, DEFAULT_MCP_SETTINGS.maxOutputChars, 1_000, 200_000)
	};
}
