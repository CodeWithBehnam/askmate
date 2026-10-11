/**
 * Pure selection logic for vault-aware @mentions: @links, @backlinks, @tag:<tag> and @recent.
 * Everything here works on plain data; the thin layer in ContextService reads the Obsidian metadata cache.
 */

export type VaultMention =
	| { kind: "links" }
	| { kind: "backlinks" }
	| { kind: "tag"; tag: string }
	| { kind: "recent"; count: number };

export const DEFAULT_RECENT_COUNT = 5;
export const MAX_RECENT_COUNT = 20;
/** Upper bound of notes taken from one mention, so a popular tag cannot flood the prompt. */
export const MAX_NOTES_PER_VAULT_MENTION = 10;

export interface VaultNoteMeta {
	path: string;
	mtime: number;
	/** Tags as Obsidian reports them, with a leading "#". */
	tags: string[];
}

export interface VaultData {
	/** Obsidian's metadataCache.resolvedLinks: source path to target path to link count. */
	resolvedLinks: Record<string, Record<string, number>>;
	/** Resolved targets of the current note's links in order of appearance; may repeat and may hold non-Markdown paths. */
	orderedLinkTargets: string[];
	notes: VaultNoteMeta[];
}

export interface VaultMentionResolution {
	mention: VaultMention;
	/** Short label for messages, such as "@tag:project". */
	label: string;
	/** Included in the prompt as the relation of each note, such as "backlink" or "tag #project". */
	relation: string;
	included: string[];
	/** Matching notes left out by the per-mention cap. */
	dropped: string[];
	/** Selected notes not read because the character limit for attached notes ran out first. */
	overBudget: string[];
}

export class VaultMentionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VaultMentionError";
	}
}

const isMarkdownPath = (path: string): boolean => path.toLowerCase().endsWith(".md");

export function vaultMentionKey(mention: VaultMention): string {
	switch (mention.kind) {
		case "tag":
			return `tag:${mention.tag}`;
		case "recent":
			return `recent:${mention.count}`;
		default:
			return mention.kind;
	}
}

export function vaultMentionLabel(mention: VaultMention): string {
	switch (mention.kind) {
		case "links":
			return "@links";
		case "backlinks":
			return "@backlinks";
		case "tag":
			return `@tag:${mention.tag}`;
		case "recent":
			return `@recent:${mention.count}`;
	}
}

export function vaultMentionRelation(mention: VaultMention): string {
	switch (mention.kind) {
		case "links":
			return "linked from current note";
		case "backlinks":
			return "backlink to current note";
		case "tag":
			return `tag #${mention.tag}`;
		case "recent":
			return "recently modified";
	}
}

/** Lower-case, no leading "#", no trailing slash. Returns null when nothing usable is left. */
export function normaliseTag(raw: string): string | null {
	const tag = raw.trim().replace(/^#+/, "").replace(/\/+$/, "").toLowerCase();
	return tag && !/\s/.test(tag) ? tag : null;
}

/** Parses the text after "@recent:". Returns null for anything that is not a whole number of at least 1. */
export function parseRecentCount(raw: string | undefined): number | null {
	if (raw === undefined || raw === "") {
		return DEFAULT_RECENT_COUNT;
	}
	if (!/^\d+$/.test(raw)) {
		return null;
	}
	const value = Number(raw);
	return value < 1 ? null : Math.min(value, MAX_RECENT_COUNT);
}

const byRecency = (mtimes: ReadonlyMap<string, number>) => (a: string, b: string): number =>
	(mtimes.get(b) ?? 0) - (mtimes.get(a) ?? 0) || a.localeCompare(b);

function mtimeMap(notes: readonly VaultNoteMeta[]): Map<string, number> {
	return new Map(notes.map((note) => [note.path, note.mtime]));
}

/** Outgoing Markdown links in order of first appearance, then any remaining resolved links by count and path. */
export function selectLinkedPaths(currentPath: string, data: Pick<VaultData, "resolvedLinks" | "orderedLinkTargets">): string[] {
	const counts = data.resolvedLinks[currentPath] ?? {};
	const valid = (path: string): boolean => path !== currentPath && isMarkdownPath(path);
	const seen = new Set<string>();
	const ordered = data.orderedLinkTargets.filter((path) => {
		if (!valid(path) || seen.has(path)) {
			return false;
		}
		seen.add(path);
		return true;
	});
	const rest = Object.keys(counts)
		.filter((path) => valid(path) && !seen.has(path) && (counts[path] ?? 0) > 0)
		.sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b));
	return [...ordered, ...rest];
}

/** Notes linking to the current note: most links first, then most recently modified. */
export function selectBacklinkPaths(currentPath: string, data: Pick<VaultData, "resolvedLinks" | "notes">): string[] {
	const mtimes = mtimeMap(data.notes);
	const sources = Object.entries(data.resolvedLinks)
		.filter(([source, targets]) => source !== currentPath && isMarkdownPath(source) && (targets[currentPath] ?? 0) > 0)
		.map(([source, targets]) => ({ source, count: targets[currentPath] ?? 0 }));
	return sources
		.sort((a, b) => b.count - a.count || byRecency(mtimes)(a.source, b.source))
		.map((entry) => entry.source);
}

/** True when the note carries the tag or a nested child of it, so "project" matches "#project/alpha". */
export function noteHasTag(noteTags: readonly string[], wanted: string): boolean {
	return noteTags.some((raw) => {
		const tag = normaliseTag(raw);
		return tag !== null && (tag === wanted || tag.startsWith(`${wanted}/`));
	});
}

export function selectTaggedPaths(tag: string, currentPath: string, notes: readonly VaultNoteMeta[]): string[] {
	const wanted = normaliseTag(tag);
	if (!wanted) {
		return [];
	}
	const mtimes = mtimeMap(notes);
	return notes
		.filter((note) => note.path !== currentPath && isMarkdownPath(note.path) && noteHasTag(note.tags, wanted))
		.map((note) => note.path)
		.sort(byRecency(mtimes));
}

/** Distinct tags across the notes, most used first, with the first-seen spelling. */
export function rankVaultTags(notes: readonly Pick<VaultNoteMeta, "tags">[]): string[] {
	const counts = new Map<string, { tag: string; count: number }>();
	for (const tag of notes.flatMap((entry) => entry.tags)) {
		const key = normaliseTag(tag);
		if (key !== null) {
			const seen = counts.get(key);
			counts.set(key, { tag: seen?.tag ?? tag, count: (seen?.count ?? 0) + 1 });
		}
	}
	return Array.from(counts.entries())
		.sort(([a, x], [b, y]) => y.count - x.count || a.localeCompare(b))
		.map(([, entry]) => entry.tag);
}

export function selectRecentPaths(count: number, currentPath: string, notes: readonly VaultNoteMeta[]): string[] {
	const mtimes = mtimeMap(notes);
	return notes
		.filter((note) => note.path !== currentPath && isMarkdownPath(note.path))
		.map((note) => note.path)
		.sort(byRecency(mtimes))
		.slice(0, Math.min(Math.max(count, 1), MAX_RECENT_COUNT));
}

function zeroResultMessage(mention: VaultMention): string {
	switch (mention.kind) {
		case "links":
			return "@links: the current note does not link to any other note.";
		case "backlinks":
			return "@backlinks: no other note links to the current note.";
		case "tag":
			return `@tag:${mention.tag}: no other note has the tag #${mention.tag}.`;
		case "recent":
			return "@recent: there are no other notes to show.";
	}
}

/**
 * Resolves every mention to a capped list of notes. A note is attached once, under the first mention that selects it.
 * Throws VaultMentionError when a mention matches nothing, in the same spirit as a missing @folder.
 */
export function resolveVaultMentions(
	mentions: readonly VaultMention[],
	currentPath: string | null,
	data: VaultData,
	cap = MAX_NOTES_PER_VAULT_MENTION
): VaultMentionResolution[] {
	const taken = new Set<string>();
	return mentions.map((mention) => {
		if ((mention.kind === "links" || mention.kind === "backlinks") && !currentPath) {
			throw new VaultMentionError(`${vaultMentionLabel(mention)} needs a note. Open a Markdown note first.`);
		}
		const path = currentPath ?? "";
		const all = mention.kind === "links"
			? selectLinkedPaths(path, data)
			: mention.kind === "backlinks"
				? selectBacklinkPaths(path, data)
				: mention.kind === "tag"
					? selectTaggedPaths(mention.tag, path, data.notes)
					: selectRecentPaths(mention.count, path, data.notes);
		if (all.length === 0) {
			throw new VaultMentionError(zeroResultMessage(mention));
		}
		const fresh = all.filter((candidate) => !taken.has(candidate));
		const included = fresh.slice(0, cap);
		included.forEach((candidate) => taken.add(candidate));
		return {
			mention,
			label: vaultMentionLabel(mention),
			relation: vaultMentionRelation(mention),
			included,
			dropped: fresh.slice(cap),
			overBudget: []
		};
	});
}

/** Plain-text lines for the /context preview: what each mention attached and what the cap left out. */
export function describeVaultMentionResolutions(resolutions: readonly VaultMentionResolution[]): string[] {
	return resolutions.map((resolution) => {
		const dropped = resolution.dropped.length > 0
			? `; ${resolution.dropped.length} more left out by the ${MAX_NOTES_PER_VAULT_MENTION}-note cap`
			: "";
		const overBudget = resolution.overBudget.length > 0
			? `; ${resolution.overBudget.length} not read, character limit reached (${resolution.overBudget.join(", ")})`
			: "";
		return `mention   ${resolution.label}: ${resolution.included.join(", ") || "nothing new"}${dropped}${overBudget}`;
	});
}
