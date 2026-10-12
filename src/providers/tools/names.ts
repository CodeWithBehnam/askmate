/**
 * Tool names are chosen by whoever defines the tool and read back from the model, so the name that reaches a provider is
 * never the author's own. One wire alphabet is valid on every provider, mapping is reversible, and a model-chosen name
 * reaches a tool only by looking it up in the map built for the run.
 */

/** OpenAI and Azure allow 64 characters, Anthropic 128, Gemini 64. The smallest wins. */
export const WIRE_NAME_MAX = 64;

/** Where a tool comes from. `serverId` is the MCP server id, or "askmate" for a first-party tool. */
export interface ToolRef {
	readonly serverId: string;
	readonly toolName: string;
}

const HASH_SUFFIX_LENGTH = 9;

function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function identityOf(ref: ToolRef): string {
	return `${ref.serverId}\u0000${ref.toolName}`;
}

/**
 * OpenAI and Azure: ^[a-zA-Z0-9_-]{1,64}$. Gemini asks for letters, digits and underscores and a letter or underscore
 * first. MCP allows dots and 128 characters. Only the common subset is used, and the server id is part of the name so two
 * servers that both expose "search" never clash.
 */
function sanitise(ref: ToolRef): string {
	const joined = `${ref.serverId}__${ref.toolName}`.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");
	return joined || "_";
}

function withHash(base: string, ref: ToolRef): string {
	return `${base.slice(0, WIRE_NAME_MAX - HASH_SUFFIX_LENGTH)}_${fnv1a(identityOf(ref))}`;
}

/**
 * Maps each tool to a wire name and returns wire name to tool. A name that is clean and short stays readable
 * (github__search_issues). A name that had to be shortened, or that collides with another once sanitised, gets a hash of
 * the tool's identity, so the result does not depend on the order the tools were listed in. Listing the same tool twice
 * keeps the first.
 */
export function buildToolNameMap<T extends ToolRef>(tools: readonly T[]): ReadonlyMap<string, T> {
	const unique = tools.filter((tool, index) => tools.findIndex((other) => identityOf(other) === identityOf(tool)) === index);
	const preferred = unique.map((tool) => sanitise(tool));
	const counts = preferred.reduce((acc, name) => acc.set(name, (acc.get(name) ?? 0) + 1), new Map<string, number>());
	const result = new Map<string, T>();

	unique.forEach((tool, index) => {
		const base = preferred[index];
		const clash = (counts.get(base) ?? 0) > 1;
		let candidate = clash || base.length > WIRE_NAME_MAX ? withHash(base, tool) : base;

		// Two different identities hashing alike is vanishingly rare, but a duplicate name would fail the whole request.
		for (let attempt = 2; result.has(candidate); attempt += 1) {
			const suffix = `_${attempt}`;
			candidate = `${candidate.slice(0, WIRE_NAME_MAX - suffix.length)}${suffix}`;
		}

		result.set(candidate, tool);
	});

	return result;
}

/** The wire name chosen for a tool in a map built by buildToolNameMap, or undefined when the tool is not in it. */
export function findWireName(map: ReadonlyMap<string, ToolRef>, ref: ToolRef): string | undefined {
	for (const [wireName, candidate] of map) {
		if (candidate.serverId === ref.serverId && candidate.toolName === ref.toolName) {
			return wireName;
		}
	}

	return undefined;
}
