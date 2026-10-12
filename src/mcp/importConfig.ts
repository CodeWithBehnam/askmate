import {
	MAX_SERVERS,
	type McpServerConfig,
	type McpValue,
	isValidHeaderName,
	secretIdFor,
	slugifyServerId,
	validateServerConfig
} from "./config";
import { sanitiseDisplayName } from "./toolPolicy";

/**
 * Turns the JSON people paste from other MCP clients (Claude Desktop, Cursor, VS Code, Claude Code, Cline) into AskMate server
 * definitions. Pure: it returns the new definitions and the secret values that must go into SecretStorage, and stores nothing.
 * Imported servers are never trusted. The person still reviews the exact command in the trust dialog before anything runs.
 */

export interface ImportedSecret {
	readonly secretId: string;
	readonly value: string;
	/** Where it came from, e.g. `env GITHUB_TOKEN`, for the confirmation list. */
	readonly source: string;
}

export interface ImportedServer {
	readonly config: McpServerConfig;
	/** Values to store with SecretStorage.setSecret. The config only holds their ids. */
	readonly secrets: readonly ImportedSecret[];
	readonly warnings: readonly string[];
}

export interface ImportSkip {
	readonly name: string;
	readonly reason: string;
}

export interface ImportResult {
	readonly servers: readonly ImportedServer[];
	readonly skipped: readonly ImportSkip[];
	/** Set when nothing could be read at all (not JSON, or no server list). */
	readonly error: string | null;
}

const MAX_IMPORT_CHARS = 200_000;
const MAX_LABEL_CHARS = 60;
const SECRET_NAME = /(?:key|token|secret|passw(?:or)?d|credential|auth|bearer|cookie|session)/i;
const PLACEHOLDER = /\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*\b|%[A-Za-z_][A-Za-z0-9_]*%/;
const IGNORED_FIELDS: ReadonlyArray<readonly [string, string]> = [
	["cwd", "AskMate does not set a working directory for a server."],
	["envFile", "AskMate does not read environment files. Add the variables to this server instead."],
	["autoApprove", "AskMate asks before every tool call unless you change the approval mode for this server."],
	["alwaysAllow", "AskMate asks before every tool call unless you change the approval mode for this server."],
	["timeout", "The timeout was not imported. Set one in this server's settings if needed."]
];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Removes // and block comments and trailing commas, which VS Code allows in mcp.json, without touching text inside strings.
 * Two small state machines keep each rule readable.
 */
export function stripJsonComments(text: string): string {
	let withoutComments = "";
	let inString = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text.charAt(index);
		const next = text.charAt(index + 1);
		if (inString) {
			withoutComments += char;
			if (char === "\\") {
				withoutComments += next;
				index += 1;
			} else if (char === "\"") {
				inString = false;
			}
		} else if (char === "\"") {
			inString = true;
			withoutComments += char;
		} else if (char === "/" && next === "/") {
			while (index < text.length && text.charAt(index) !== "\n") {
				index += 1;
			}
			withoutComments += "\n";
		} else if (char === "/" && next === "*") {
			index += 2;
			while (index < text.length && !(text.charAt(index) === "*" && text.charAt(index + 1) === "/")) {
				index += 1;
			}
			index += 1;
		} else {
			withoutComments += char;
		}
	}

	let result = "";
	inString = false;
	for (let index = 0; index < withoutComments.length; index += 1) {
		const char = withoutComments.charAt(index);
		if (inString) {
			result += char;
			if (char === "\\") {
				result += withoutComments.charAt(index + 1);
				index += 1;
			} else if (char === "\"") {
				inString = false;
			}
		} else if (char === "\"") {
			inString = true;
			result += char;
		} else if (char === ",") {
			let lookahead = index + 1;
			while (/\s/.test(withoutComments.charAt(lookahead))) {
				lookahead += 1;
			}
			const following = withoutComments.charAt(lookahead);
			if (following !== "}" && following !== "]") {
				result += char;
			}
		} else {
			result += char;
		}
	}
	return result;
}

function urlOf(definition: UnknownRecord): string | null {
	const candidate = [definition.url, definition.serverUrl, definition.httpUrl].find((value): value is string => typeof value === "string" && value.trim() !== "");
	return candidate?.trim() ?? null;
}

function commandOf(definition: UnknownRecord): string | null {
	return typeof definition.command === "string" && definition.command.trim() !== "" ? definition.command : null;
}

function looksLikeServer(value: unknown): value is UnknownRecord {
	return isRecord(value) && (commandOf(value) !== null || urlOf(value) !== null);
}

/** Finds the server list in any of the shapes seen in the wild: `mcpServers`, `servers`, `mcp.servers`, a bare map, or one server. */
function locateServers(root: unknown): Array<[string, unknown]> | null {
	const fromList = (list: unknown): Array<[string, unknown]> | null => {
		if (isRecord(list)) {
			return Object.entries(list);
		}
		if (Array.isArray(list)) {
			return list.flatMap((item, position): Array<[string, unknown]> =>
				isRecord(item) ? [[typeof item.name === "string" && item.name.trim() ? item.name : `Server ${position + 1}`, item]] : []
			);
		}
		return null;
	};
	if (Array.isArray(root)) {
		return fromList(root);
	}
	if (!isRecord(root)) {
		return null;
	}
	const mcp = isRecord(root.mcp) ? root.mcp : null;
	const listed = fromList(root.mcpServers) ?? fromList(root.servers) ?? (mcp ? fromList(mcp.servers) ?? fromList(mcp.mcpServers) : null);
	if (listed) {
		return listed;
	}
	if (looksLikeServer(root)) {
		return [["Imported server", root]];
	}
	const entries = Object.entries(root);
	return entries.length > 0 && entries.every(([, value]) => looksLikeServer(value)) ? entries : null;
}

function asText(value: unknown): string | null {
	return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

/** Everything one imported server accumulates while it is converted. */
class Draft {
	readonly secrets: ImportedSecret[] = [];
	readonly warnings: string[] = [];
	private readonly usedSecretIds = new Set<string>();

	constructor(readonly serverId: string) {}

	secretId(name: string): string {
		const base = secretIdFor(this.serverId, name);
		let candidate = base;
		for (let n = 2; this.usedSecretIds.has(candidate); n += 1) {
			candidate = `${base}-${n}`;
		}
		this.usedSecretIds.add(candidate);
		return candidate;
	}

	/** A value that looks like a secret becomes a reference and its text goes to the secrets list. Everything else stays visible. */
	value(kind: "env" | "header", name: string, raw: string): McpValue {
		if (!SECRET_NAME.test(name)) {
			if (PLACEHOLDER.test(raw)) {
				this.warnings.push(`${kind} ${name} contains a placeholder that AskMate does not expand. Replace it with the real value.`);
			}
			return { kind: "plain", value: raw };
		}
		const secretId = this.secretId(name);
		if (raw === "" || PLACEHOLDER.test(raw)) {
			this.warnings.push(`${kind} ${name} has no usable value in the import. Set the secret "${secretId}" in this server's settings.`);
		} else {
			this.secrets.push({ secretId, value: raw, source: `${kind} ${name}` });
		}
		return { kind: "secret", secretId };
	}
}

function convertEntry(name: string, raw: unknown, taken: ReadonlySet<string>): ImportedServer | ImportSkip {
	const label = sanitiseDisplayName(name, MAX_LABEL_CHARS) || "Imported server";
	if (!isRecord(raw)) {
		return { name: label, reason: "The entry is not an object." };
	}
	const type = (asText(raw.type) ?? asText(raw.transport) ?? "").toLowerCase();
	const url = urlOf(raw);
	const command = commandOf(raw);

	if (type === "sse") {
		return { name: label, reason: "It uses the retired HTTP+SSE transport. Ask the server author for Streamable HTTP, or run it through a stdio bridge." };
	}
	if (type === "websocket" || type === "ws") {
		return { name: label, reason: "WebSocket servers are not supported." };
	}
	const wantsHttp = ["http", "streamable-http", "streamablehttp", "streamable_http"].includes(type);
	const transport = type === "stdio" ? "stdio" : wantsHttp ? "http" : command !== null ? "stdio" : url !== null ? "http" : null;
	if (transport === null) {
		return { name: label, reason: "It has neither a command nor a URL." };
	}

	const draft = new Draft(slugifyServerId(label, taken));
	IGNORED_FIELDS.filter(([field]) => raw[field] !== undefined).forEach(([field, advice]) => draft.warnings.push(`"${field}" was not imported. ${advice}`));
	const base = {
		id: draft.serverId,
		label,
		enabled: raw.disabled !== true,
		approval: "always-ask" as const,
		trustsAnnotations: false,
		disabledTools: [] as string[]
	};

	let config: McpServerConfig;
	if (transport === "stdio") {
		if (command === null) {
			return { name: label, reason: "A local server needs a command." };
		}
		const rawArgs = raw.args === undefined ? [] : raw.args;
		if (!Array.isArray(rawArgs) || rawArgs.some((arg) => asText(arg) === null)) {
			return { name: label, reason: "The arguments must be a list of text values." };
		}
		if (/\s/.test(command) && rawArgs.length === 0 && !/[\\/]/.test(command)) {
			draft.warnings.push("The command contains spaces and there are no arguments. Put the program in the command and each argument in its own entry.");
		}
		const env = Object.fromEntries(
			Object.entries(isRecord(raw.env) ? raw.env : {}).flatMap(([envName, envValue]): Array<[string, McpValue]> => {
				const text = asText(envValue);
				return text === null ? [] : [[envName, draft.value("env", envName, text)]];
			})
		);
		config = { ...base, transport: "stdio", command, args: rawArgs.map((arg) => asText(arg) ?? ""), env };
	} else {
		if (url === null) {
			return { name: label, reason: "A remote server needs a URL." };
		}
		if (/\/sse\/?$/i.test(url.split(/[?#]/)[0] ?? "")) {
			draft.warnings.push("The URL ends in /sse. If the connection fails, the server may use the retired HTTP+SSE transport.");
		}
		let bearerSecretId: string | null = null;
		const headers: Record<string, McpValue> = {};
		for (const [headerName, headerValue] of Object.entries(isRecord(raw.headers) ? raw.headers : {})) {
			const text = asText(headerValue);
			if (text === null) {
				continue;
			}
			const bearer = headerName.toLowerCase() === "authorization" ? /^Bearer\s+(.*)$/i.exec(text.trim()) : null;
			if (bearer) {
				bearerSecretId = draft.secretId("token");
				const token = bearer[1] ?? "";
				if (token === "" || PLACEHOLDER.test(token)) {
					draft.warnings.push(`The bearer token has no usable value in the import. Set the secret "${bearerSecretId}" in this server's settings.`);
				} else {
					draft.secrets.push({ secretId: bearerSecretId, value: token, source: "header Authorization" });
				}
			} else if (isValidHeaderName(headerName)) {
				headers[headerName] = draft.value("header", headerName, text);
			} else {
				draft.warnings.push(`The header "${headerName}" was not imported because AskMate sets or restricts it.`);
			}
		}
		config = { ...base, transport: "http", url, headers, bearerSecretId };
	}

	const problems = validateServerConfig(config);
	if (problems.length > 0) {
		return { name: label, reason: problems[0] ?? "The settings are not valid." };
	}
	return { config, secrets: draft.secrets, warnings: draft.warnings };
}

function isImported(result: ImportedServer | ImportSkip): result is ImportedServer {
	return "config" in result;
}

/** `takenIds` are the ids of servers that already exist, so imported ones get distinct ids and secret names. */
export function parseMcpImport(text: string, takenIds: ReadonlySet<string> = new Set()): ImportResult {
	if (text.length > MAX_IMPORT_CHARS) {
		return { servers: [], skipped: [], error: "That is too much text to import." };
	}
	let root: unknown;
	try {
		root = JSON.parse(stripJsonComments(text));
	} catch {
		return { servers: [], skipped: [], error: "That is not valid JSON." };
	}
	const entries = locateServers(root);
	if (entries === null || entries.length === 0) {
		return { servers: [], skipped: [], error: "No servers found. Paste a JSON object with an mcpServers or servers list." };
	}

	const servers: ImportedServer[] = [];
	const skipped: ImportSkip[] = [];
	const used = new Set(takenIds);
	for (const [name, raw] of entries) {
		if (servers.length + takenIds.size >= MAX_SERVERS) {
			skipped.push({ name: sanitiseDisplayName(name, MAX_LABEL_CHARS), reason: `AskMate keeps at most ${MAX_SERVERS} servers.` });
			continue;
		}
		const converted = convertEntry(name, raw, used);
		if (isImported(converted)) {
			used.add(converted.config.id);
			servers.push(converted);
		} else {
			skipped.push(converted);
		}
	}
	return { servers, skipped, error: servers.length === 0 && skipped.length === 0 ? "No servers found." : null };
}
