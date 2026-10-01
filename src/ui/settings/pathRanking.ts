/** Dot-prefixed segments such as `.obsidian` and `.trash` hold app data, so they are never useful as suggestions. */
export function isHiddenVaultPath(path: string): boolean {
	return path.split("/").some((segment) => segment.startsWith("."));
}

/** The folder part of a typed path, so the note suggester lists one folder at a time. "" means the vault root. */
export function getQueryFolderPath(query: string): string {
	const trimmed = query.trim();
	const slash = trimmed.lastIndexOf("/");
	return slash > 0 ? trimmed.slice(0, slash).replace(/\/+$/, "") : "";
}

function lastSegment(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function cap<T>(items: T[], limit: number): T[] {
	return limit > 0 ? items.slice(0, limit) : items;
}

/**
 * Case-insensitive type-ahead ranking: every whitespace-separated token must appear in the path,
 * and paths whose file name or whole path starts with the query come first because that is what the user is usually typing.
 */
export function rankPathSuggestions(paths: readonly string[], query: string, limit: number): string[] {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) {
		return cap([...paths].sort((a, b) => a.localeCompare(b)), limit);
	}

	const tokens = trimmed.split(/\s+/);
	const ranked = paths
		.map((path) => ({ path, lower: path.toLowerCase() }))
		.filter(({ lower }) => tokens.every((token) => lower.includes(token)))
		.map(({ path, lower }) => ({
			path,
			length: lower.length,
			tier: lastSegment(lower).startsWith(trimmed) ? 0 : lower.startsWith(trimmed) ? 1 : 2,
		}))
		.sort((a, b) => a.tier - b.tier || a.length - b.length || a.path.localeCompare(b.path));

	return cap(ranked.map(({ path }) => path), limit);
}
