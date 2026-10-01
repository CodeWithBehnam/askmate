import { isImageReferencePath } from "../settings/normalize";

/** Tags AskMate uses to delimit prompt sections. Untrusted text must never be able to open or close one. */
export const PROMPT_DELIMITER_TAGS = [
	"note_context",
	"context_attachment",
	"evidence_sources",
	"user_request",
	"image_request"
] as const;

// No trailing boundary check: a model may still read `</note_context` followed by a zero-width space, or `<user_request-`, as a delimiter,
// and escaping a longer name that merely starts with a tag name is harmless.
const PROMPT_DELIMITER_PATTERN = new RegExp(`<(\\s*/?\\s*)(${PROMPT_DELIMITER_TAGS.join("|")})`, "gi");

export const IMAGE_REFERENCE_OMITTED = "[Image reference omitted by AskMate privacy controls.]";

/**
 * Neutralises AskMate's own delimiter tags inside untrusted note, attachment, history or evidence text,
 * so that content cannot close a section early or forge a new user_request.
 */
export function escapePromptDelimiters(text: string): string {
	return text.replace(PROMPT_DELIMITER_PATTERN, "&lt;$1$2");
}

/** Makes a value safe inside a double-quoted tag attribute on a single line. */
export function escapePromptAttribute(value: string): string {
	return value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/"/g, "'")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Extracts the target from a Markdown link destination, which may be `<path with spaces>` or followed by a title. */
function getLinkDestinationTarget(destination: string): string {
	const value = destination.trim();
	if (value.startsWith("<")) {
		const end = value.indexOf(">");
		return end === -1 ? value.slice(1) : value.slice(1, end);
	}
	return value.split(/\s+/)[0] ?? "";
}

/**
 * Removes image references when the user has excluded them. `bareLines` also removes lines that are only an image
 * path, which is how Excalidraw summaries list embedded files.
 */
export function stripImageReferences(text: string, options: { bareLines?: boolean } = {}): string {
	const stripped = text
		.replace(/!?\[\[([^\]]+)\]\]/g, (match, reference: string) => {
			return isImageReferencePath(reference) ? IMAGE_REFERENCE_OMITTED : match;
		})
		.replace(/!?\[[^\]]*\]\(([^)]*)\)/g, (match, destination: string) => {
			return isImageReferencePath(getLinkDestinationTarget(destination)) ? IMAGE_REFERENCE_OMITTED : match;
		})
		.replace(/^([ \t]{0,3}\[[^\]]+\]:[ \t]*)(\S.*)$/gm, (match, _label: string, destination: string) => {
			return isImageReferencePath(getLinkDestinationTarget(destination)) ? IMAGE_REFERENCE_OMITTED : match;
		})
		.replace(/<img\b[^>]*>/gi, IMAGE_REFERENCE_OMITTED);

	if (!options.bareLines) {
		return stripped;
	}
	return stripped.replace(/^[ \t]*(\S[^\n]*?)[ \t]*$/gm, (match, line: string) => {
		return isImageReferencePath(line) ? IMAGE_REFERENCE_OMITTED : match;
	});
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** Moves a cut index back so it never falls between the two halves of a surrogate pair. */
export function snapCutBackward(text: string, index: number): number {
	const clamped = Math.max(0, Math.min(text.length, index));
	return clamped > 0 && clamped < text.length && isHighSurrogate(text.charCodeAt(clamped - 1)) && isLowSurrogate(text.charCodeAt(clamped))
		? clamped - 1
		: clamped;
}

/** Moves a cut index forward so it never falls between the two halves of a surrogate pair. */
export function snapCutForward(text: string, index: number): number {
	const clamped = Math.max(0, Math.min(text.length, index));
	return clamped > 0 && clamped < text.length && isHighSurrogate(text.charCodeAt(clamped - 1)) && isLowSurrogate(text.charCodeAt(clamped))
		? clamped + 1
		: clamped;
}

/** Truncates to at most `maxLength` UTF-16 units without splitting a code point. */
export function truncateAtCodePoint(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : text.slice(0, snapCutBackward(text, maxLength));
}
