import { createNextIndexOf, createScanBudget, type ScanBudget } from "../safety/scan";
import { isImageReferencePath } from "../settings/normalize";

/** Tags AskMate uses to delimit prompt sections. Untrusted text must never be able to open or close one. */
export const PROMPT_DELIMITER_TAGS = [
	"note_context",
	"context_attachment",
	"evidence_sources",
	"user_request",
	"image_request",
	"skill",
	"skill_context",
	"active_skills",
	"tool_result",
	"tool_definitions"
] as const;

/** A tag name that tolerates format characters (zero width, word joiner, soft hyphen, bidi) between its letters. */
function spellOut(tag: string): string {
	return tag.split("").join("\\p{Cf}*");
}

// The gaps accept whitespace and format characters, because a model may still read `<\u200B/note_context` or `</note_context`
// followed by a zero-width space as a delimiter. The optional slash group keeps the two gaps from competing for the same
// characters, so a long run of spaces is read once. There is no trailing boundary check: `<user_request-` is escaped too,
// and escaping a longer name that merely starts with a tag name is harmless.
const PROMPT_DELIMITER_PATTERN = new RegExp(
	`<((?:[\\s\\p{Cf}]*/)?[\\s\\p{Cf}]*)(${PROMPT_DELIMITER_TAGS.map(spellOut).join("|")})`,
	"giu"
);

export const IMAGE_REFERENCE_OMITTED = "[Image reference omitted by AskMate privacy controls.]";

/**
 * Neutralises AskMate's own delimiter tags inside untrusted note, attachment, history, skill or tool text,
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

const DATA_IMAGE_PREFIX = /^data:image\//i;
const IMAGE_TAG = /<(img|source|image)(?=[\s/>]|$)/iy;
const IMAGE_ATTRIBUTE = /(?:^|[\s"'/])(?:src|srcset|href|xlink:href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
/** How far a destination or an img tag is read before the cheaper fallbacks take over. Ordinary ones are far shorter. */
const DESTINATION_WINDOW = 4096;
const TAG_WINDOW = 8192;

/** A path with an image extension, or an inline data:image URI. */
function isImageTarget(target: string): boolean {
	const trimmed = target.trim();
	return DATA_IMAGE_PREFIX.test(trimmed) || isImageReferencePath(trimmed);
}

/** Drops a trailing Markdown link title from a destination that was not wrapped in angle brackets. */
function stripTitle(content: string): string {
	return content.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/, "");
}

interface ParenContent {
	/** Index just past the closing parenthesis. */
	end: number;
	content: string;
}

interface Lookups {
	nextCloseBracket: (from: number) => number;
	nextCloseParen: (from: number) => number;
	nextGreaterThan: (from: number) => number;
	budget: ScanBudget;
}

/** Reads the balanced parenthesised destination that starts at the "(" at `openIndex`. */
function readParenContent(text: string, openIndex: number, lookups: Lookups): ParenContent | null {
	const { nextCloseParen, nextGreaterThan, budget } = lookups;
	let start = openIndex + 1;
	while (start < text.length && /\s/.test(text[start])) {
		start += 1;
	}
	// A data: URI holds no parenthesis, so its end is the next one, however long the payload is.
	if (DATA_IMAGE_PREFIX.test(text.slice(start, start + 11))) {
		const close = nextCloseParen(start);
		return close === -1 ? null : { end: close + 1, content: text.slice(start, close) };
	}

	let depth = 1;
	const limit = Math.min(text.length, openIndex + 1 + DESTINATION_WINDOW);
	if (!budget.spend(limit - openIndex)) {
		// The text is full of destinations that never close. Read each one up to the next parenthesis, which is cheap.
		const close = nextCloseParen(openIndex + 1);
		return close === -1 ? null : { end: close + 1, content: text.slice(openIndex + 1, close) };
	}
	let index = openIndex + 1;
	if (text[start] === "<") {
		// Inside angle brackets a parenthesis is just a character, so skip to the closing bracket on the same line.
		const close = nextGreaterThan(start + 1);
		if (close !== -1 && close < limit && !text.slice(start, close).includes("\n")) {
			index = close + 1;
		}
	}
	for (; index < limit; index += 1) {
		const char = text[index];
		if (char === "\\") {
			index += 1;
		} else if (char === "(") {
			depth += 1;
		} else if (char === ")") {
			depth -= 1;
			if (depth === 0) {
				return { end: index + 1, content: text.slice(openIndex + 1, index) };
			}
		}
	}
	return null;
}

/** True when the parenthesised part of a Markdown link points at an image, however its path is written. */
function destinationIsImage(content: string): boolean {
	const value = content.trim();
	if (value.startsWith("<")) {
		const close = value.indexOf(">");
		if (close !== -1 && isImageTarget(value.slice(1, close))) {
			return true;
		}
	}
	// Paths with spaces and parentheses (screenshot names) are written without angle brackets all the time.
	return isImageTarget(getLinkDestinationTarget(value)) || isImageTarget(stripTitle(value));
}

/** True when an img, source or image tag names an image. Every img tag does; the others only when a source is an image. */
function tagNamesImage(name: string, tagText: string): boolean {
	if (name === "img") {
		return true;
	}
	for (const match of tagText.matchAll(IMAGE_ATTRIBUTE)) {
		const value = match[1] ?? match[2] ?? match[3] ?? "";
		if (value.split(",").some((candidate) => isImageTarget(candidate.trim().split(/\s+/)[0] ?? ""))) {
			return true;
		}
	}
	return false;
}

/** Index just past the ">" that ends the img-like tag at `index`, or -1. Quotes are honoured while the budget allows. */
function findImageTagEnd(text: string, nameEnd: number, nextGreaterThan: (from: number) => number, budget: ScanBudget): number {
	const limit = Math.min(text.length, nameEnd + TAG_WINDOW);
	if (budget.spend(limit - nameEnd)) {
		let quote: string | null = null;
		for (let cursor = nameEnd; cursor < limit; cursor += 1) {
			const char = text[cursor];
			if (quote) {
				quote = char === quote ? null : quote;
			} else if (char === "\"" || char === "'") {
				quote = char;
			} else if (char === ">") {
				return cursor + 1;
			}
		}
	}
	// Past the window (a base64 payload) or with an unterminated quote, the first ">" is the best reading.
	const greaterThan = nextGreaterThan(nameEnd);
	return greaterThan === -1 ? -1 : greaterThan + 1;
}

/** Index just past a wikilink, image or link at `start` that names an image, or -1. */
function findImageReferenceEnd(text: string, start: number, lookups: Lookups): number {
	const { nextCloseBracket } = lookups;
	const open = text[start] === "!" ? start + 1 : start;
	if (text[open + 1] === "[") {
		const close = nextCloseBracket(open + 2);
		if (close > open + 2 && text[close + 1] === "]" && isImageReferencePath(text.slice(open + 2, close))) {
			return close + 2;
		}
	}
	const labelEnd = nextCloseBracket(open + 1);
	if (labelEnd === -1 || text[labelEnd + 1] !== "(") {
		return -1;
	}
	const paren = readParenContent(text, labelEnd + 1, lookups);
	return paren && destinationIsImage(paren.content) ? paren.end : -1;
}

/** One left-to-right pass over wikilinks, Markdown images and links, and img, source and image tags. */
function stripInlineImageReferences(text: string): string {
	const lookups: Lookups = {
		nextCloseBracket: createNextIndexOf(text, "]"),
		nextCloseParen: createNextIndexOf(text, ")"),
		nextGreaterThan: createNextIndexOf(text, ">"),
		budget: createScanBudget(Math.max(2_000_000, text.length * 16))
	};
	let result = "";
	let copied = 0;
	let index = 0;

	while (index < text.length) {
		const char = text[index];
		let end = -1;
		if (char === "<") {
			IMAGE_TAG.lastIndex = index;
			const match = IMAGE_TAG.exec(text);
			if (match) {
				const tagEnd = findImageTagEnd(text, index + match[0].length, lookups.nextGreaterThan, lookups.budget);
				end = tagEnd !== -1 && tagNamesImage(match[1].toLowerCase(), text.slice(index, tagEnd)) ? tagEnd : -1;
			}
		} else if (char === "[" || (char === "!" && text[index + 1] === "[")) {
			end = findImageReferenceEnd(text, index, lookups);
		}

		if (end === -1) {
			index += 1;
			continue;
		}
		result += text.slice(copied, index) + IMAGE_REFERENCE_OMITTED;
		copied = end;
		index = end;
	}
	return result + text.slice(copied);
}

/** Reference definitions (`[label]: path`) are whole lines, so they are handled line by line. */
function stripReferenceDefinitions(text: string): string {
	if (!text.includes("]:")) {
		return text;
	}
	return text
		.split("\n")
		.map((line) => {
			const match = /^[ \t]{0,3}\[[^\]\n]{1,999}\]:[ \t]*(\S.*)$/.exec(line);
			return match && isImageTarget(getLinkDestinationTarget(match[1])) ? IMAGE_REFERENCE_OMITTED : line;
		})
		.join("\n");
}

/** Trims spaces and tabs only, the way a line-anchored pattern would, without scanning long whitespace runs twice. */
function trimSpacesAndTabs(line: string): string {
	let start = 0;
	let end = line.length;
	while (start < end && (line[start] === " " || line[start] === "\t")) {
		start += 1;
	}
	while (end > start && (line[end - 1] === " " || line[end - 1] === "\t")) {
		end -= 1;
	}
	return line.slice(start, end);
}

/**
 * Removes image references when the user has excluded them: wikilink embeds, Markdown images and links (including
 * paths with parentheses, `<...>` destinations and data:image URIs), reference definitions, and img, picture source and
 * svg image tags. `bareLines` also removes lines that are only an image path, which is how Excalidraw summaries list
 * embedded files. Every pass is a single scan with bounded look-ahead, so crafted text cannot make it quadratic.
 */
export function stripImageReferences(text: string, options: { bareLines?: boolean } = {}): string {
	const stripped = stripReferenceDefinitions(stripInlineImageReferences(text));
	if (!options.bareLines) {
		return stripped;
	}
	return stripped
		.split("\n")
		.map((line) => {
			const trimmed = trimSpacesAndTabs(line);
			return trimmed !== "" && isImageReferencePath(trimmed) ? IMAGE_REFERENCE_OMITTED : line;
		})
		.join("\n");
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
