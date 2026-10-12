/**
 * Decides what a click on an internal link inside an answer should do. The view reads the clicked element and passes
 * plain values in; it then performs the one action returned.
 *
 * Model text can contain any link. Obsidian's `openLinkText` creates an empty note when a link does not resolve, so a
 * made-up `[[Name]]` in an answer would litter the vault on click. This resolves first and only opens what exists.
 */

export interface ResolvedLinkTarget {
	/** Vault path of the file the link points to. */
	path: string;
}

export interface InternalLinkInput {
	/** The link's `data-href`, falling back to `href`. */
	rawHref: string | null;
	/** Path of the note the answer was written for; links are resolved relative to it. */
	sourcePath: string;
	/** True for a modifier click, which opens the note in a new tab. */
	newLeaf: boolean;
	/** Resolves a link path (no heading or block part) the way the metadata cache does; null when nothing matches. */
	resolve: (linkpath: string, sourcePath: string) => ResolvedLinkTarget | null;
}

export type InternalLinkDecision =
	| { kind: "ignore" }
	| { kind: "open"; linktext: string; sourcePath: string; newLeaf: boolean; resolvedPath: string | null }
	| { kind: "notice"; message: string };

const MAX_LINK_LENGTH = 1000;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+:/i;

function safeDecode(value: string): string {
	if (!value.includes("%")) {
		return value;
	}
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** Link path without an alias, heading or block part, and the part that follows it. */
export function splitLinkTarget(rawHref: string): { linkpath: string; subpath: string } {
	const withoutAlias = rawHref.split("|")[0] ?? "";
	const index = withoutAlias.search(/[#^]/);
	return index < 0
		? { linkpath: withoutAlias.trim(), subpath: "" }
		: { linkpath: withoutAlias.slice(0, index).trim(), subpath: withoutAlias.slice(index) };
}

function printable(value: string): string {
	return value.replace(/\p{Cc}/gu, "").slice(0, 80);
}

export function decideInternalLink(input: InternalLinkInput): InternalLinkDecision {
	const raw = input.rawHref?.trim() ?? "";
	if (!raw || raw.length > MAX_LINK_LENGTH) {
		return { kind: "ignore" };
	}
	if (SCHEME_PATTERN.test(raw)) {
		// Web links are not this handler's job; any other scheme is not something an answer should open.
		return /^https?:/i.test(raw)
			? { kind: "ignore" }
			: { kind: "notice", message: "AskMate does not open this kind of link from an answer." };
	}

	const decoded = safeDecode(raw);
	const { linkpath } = splitLinkTarget(decoded);
	if (!linkpath) {
		return input.sourcePath
			? { kind: "open", linktext: decoded, sourcePath: input.sourcePath, newLeaf: input.newLeaf, resolvedPath: input.sourcePath }
			: { kind: "notice", message: "This link points inside a note, but this reply is not tied to one." };
	}

	const target = input.resolve(linkpath, input.sourcePath);
	if (!target) {
		return {
			kind: "notice",
			message: `There is no note called "${printable(linkpath)}" in this vault. AskMate does not create notes from links in answers.`
		};
	}
	return { kind: "open", linktext: decoded, sourcePath: input.sourcePath, newLeaf: input.newLeaf, resolvedPath: target.path };
}
