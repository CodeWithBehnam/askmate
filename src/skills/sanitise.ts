import type { SanitisedText } from "./types";

type CodeRange = readonly [first: number, last: number];

/**
 * Characters that never carry meaning a reader can see, listed as code points so the source holds none of them
 * and no regular expression has to describe them. The tag characters and the variation selector supplement are
 * how text is smuggled past a human reviewer; the rest are bidi controls, zero-width characters, the byte order
 * mark and filler characters.
 */
const ALWAYS_INVISIBLE: readonly CodeRange[] = [
	[0xe0000, 0xe007f],
	[0xe0100, 0xe01ef],
	[0x200b, 0x200b],
	[0x200e, 0x200f],
	[0x202a, 0x202e],
	[0x2060, 0x2064],
	[0x2066, 0x2069],
	[0xfeff, 0xfeff],
	[0x061c, 0x061c],
	[0x180e, 0x180e],
	[0x00ad, 0x00ad],
	[0x034f, 0x034f],
	[0x115f, 0x1160],
	[0x17b4, 0x17b5],
	[0x3164, 0x3164],
	[0xffa0, 0xffa0]
];

const ZERO_WIDTH_NON_JOINER = 0x200c;
const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_FIRST = 0xfe00;
const VARIATION_LAST = 0xfe0f;
const TEXT_PRESENTATION = 0xfe0e;
const EMOJI_PRESENTATION = 0xfe0f;

/** Zero-width joiners and variation selectors are legitimate in Persian, Indic scripts and emoji, so only runs and strays go. */
const JOINER_NEIGHBOUR = /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}]$/u;
const EMOJI_BASE = /^[\p{Extended_Pictographic}#*0-9]$/u;

const TAG_FIRST = 0xe0020;
const TAG_LAST = 0xe007e;
const TAG_BASE = 0xe0000;
const MAX_HIDDEN_TEXT = 400;

/** A code span on one line, at most 400 characters, so a stray backtick cannot make the scan quadratic. Always used at one index. */
const INLINE_CODE = /(`+)[^\n]{0,400}?\1/y;
const HTML_OPEN = "<!--";
const HTML_CLOSE = "-->";
const PERCENT = "%%";
/** The next place something may start: a comment opener, or a run of backticks that may open inline code. */
const OPENER = /<!--|%%|`+/g;
/**
 * A fence opens with three or more backticks or tildes. A backtick fence may not have a backtick in its info string,
 * because a line such as ```a``` is inline code and the lines after it are ordinary text.
 */
const FENCE_OPEN = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

export function normaliseNewlines(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

const inRanges = (code: number, ranges: readonly CodeRange[]): boolean => ranges.some(([first, last]) => code >= first && code <= last);

const isConditional = (code: number): boolean =>
	code === ZERO_WIDTH_NON_JOINER || code === ZERO_WIDTH_JOINER || (code >= VARIATION_FIRST && code <= VARIATION_LAST);

/** A lone joiner between two letters, or a lone emoji selector after an emoji, is real text. Anything else is not. */
function keepsConditional(code: number, before: string | undefined, after: string | undefined): boolean {
	if (code === ZERO_WIDTH_NON_JOINER || code === ZERO_WIDTH_JOINER) {
		return JOINER_NEIGHBOUR.test(before ?? "") && JOINER_NEIGHBOUR.test(after ?? "");
	}
	return (code === TEXT_PRESENTATION || code === EMOJI_PRESENTATION) && EMOJI_BASE.test(before ?? "");
}

interface StrippedInvisible {
	text: string;
	removed: number;
	hiddenText: string;
}

/** Removes invisible characters and recovers any text hidden in Unicode tag characters. */
export function stripInvisible(text: string): StrippedInvisible {
	const points = Array.from(text);
	const kept: string[] = [];
	let removed = 0;
	let hidden = "";
	let index = 0;
	while (index < points.length) {
		const char = points[index] ?? "";
		const code = char.codePointAt(0) ?? 0;
		if (inRanges(code, ALWAYS_INVISIBLE)) {
			removed += 1;
			if (code >= TAG_FIRST && code <= TAG_LAST && hidden.length < MAX_HIDDEN_TEXT) {
				hidden += String.fromCharCode(code - TAG_BASE);
			}
			index += 1;
		} else if (isConditional(code)) {
			let end = index + 1;
			while (end < points.length && isConditional(points[end]?.codePointAt(0) ?? 0)) {
				end += 1;
			}
			if (end - index === 1 && keepsConditional(code, points[index - 1], points[end])) {
				kept.push(char);
			} else {
				removed += end - index;
			}
			index = end;
		} else {
			kept.push(char);
			index += 1;
		}
	}
	return { text: kept.join(""), removed, hiddenText: hidden };
}

const lineEndOf = (text: string, from: number): number => {
	const index = text.indexOf("\n", from);
	return index === -1 ? text.length : index;
};

/**
 * If a fenced code block opens on the line that starts at `start`, returns the index just after its closing line, or
 * the end of the text when it never closes. Returns `start` when that line opens no fence.
 */
function skipFence(text: string, start: number): number {
	const firstEnd = lineEndOf(text, start);
	const opening = FENCE_OPEN.exec(text.slice(start, firstEnd));
	const marker = opening?.[1] ?? opening?.[2];
	if (!marker) {
		return start;
	}
	let cursor = firstEnd + 1;
	while (cursor < text.length) {
		const end = lineEndOf(text, cursor);
		const closing = FENCE_CLOSE.exec(text.slice(cursor, end))?.[1];
		if (closing && closing.startsWith(marker.charAt(0)) && closing.length >= marker.length) {
			return end + 1;
		}
		cursor = end + 1;
	}
	return text.length;
}

/** True when only spaces and tabs come before `index` on its line. */
function startsItsLine(text: string, index: number): boolean {
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const char = text.charAt(cursor);
		if (char === "\n") {
			return true;
		}
		if (char !== " " && char !== "\t") {
			return false;
		}
	}
	return true;
}

/** Start of the first line after the one holding `from` that opens a fenced block, or the end of the text. */
function nextFenceStart(text: string, from: number): number {
	let start = lineEndOf(text, from) + 1;
	while (start < text.length) {
		const end = lineEndOf(text, start);
		if (FENCE_OPEN.test(text.slice(start, end))) {
			return start;
		}
		start = end + 1;
	}
	return text.length;
}

/**
 * Removes comments that reading view hides: HTML comments and Obsidian `%%` comments. Fenced code and inline code
 * are visible there, so their content is kept as written.
 *
 * One forward pass, so the cost stays linear however many openers a file holds. A comment opener outside code starts a
 * comment that runs to its closer across any number of lines. A fence line inside that span is hidden text like the
 * rest: it neither opens nor closes a block. A fence is only recognised at the start of a line that no comment covers.
 * An HTML comment that never closes hides the rest of the page, so it is dropped to the end; a lone `%%` is plain text.
 *
 * A `%%` that starts its line is a block comment and is treated like the HTML case, so a fence inside it is hidden.
 * Obsidian's reading view was not checked for this, so it is the cautious reading: the model sees less than the reader
 * at worst, never more. A `%%` after other text on its line only pairs within the same stretch of text, up to the next
 * fence, so a stray `%%` in a sentence such as "add a %% note" cannot swallow the Mermaid example that follows it.
 */
export function stripComments(text: string): { text: string; removed: number } {
	const output: string[] = [];
	let removed = 0;
	/** Text before this index has been kept in `output` or dropped. */
	let copied = 0;
	/** Everything before this index has been read. */
	let position = 0;
	let nextNewline = -1;
	/** Start of the first fence line at or after the last mid-line `%%` that looked for one. */
	let fenceLimit = -1;
	let opener: RegExpExecArray | null = null;
	const drop = (from: number, to: number): void => {
		if (from > copied) {
			output.push(text.slice(copied, from));
		}
		copied = to;
		position = to;
		removed += 1;
	};
	while (position < text.length) {
		if (position === 0 || text.charAt(position - 1) === "\n") {
			const after = skipFence(text, position);
			if (after > position) {
				position = after;
				continue;
			}
		}
		if (opener === null || opener.index < position) {
			OPENER.lastIndex = position;
			opener = OPENER.exec(text);
			if (opener === null) {
				break;
			}
		}
		if (nextNewline < position) {
			nextNewline = lineEndOf(text, position);
		}
		if (nextNewline < opener.index) {
			// Step to the next line so a fence that starts there is seen before any opener beyond it.
			position = nextNewline + 1;
			continue;
		}
		const token = opener[0];
		if (token === HTML_OPEN) {
			const close = text.indexOf(HTML_CLOSE, opener.index + token.length);
			drop(opener.index, close === -1 ? text.length : close + HTML_CLOSE.length);
		} else if (token === PERCENT) {
			const block = startsItsLine(text, opener.index);
			if (!block && opener.index > fenceLimit) {
				fenceLimit = nextFenceStart(text, opener.index);
			}
			const close = text.indexOf(PERCENT, opener.index + token.length);
			if (close === -1 || (!block && close >= fenceLimit)) {
				position = opener.index + token.length;
			} else {
				drop(opener.index, close + PERCENT.length);
			}
		} else {
			// Inline code is visible in reading view, so a `%%` or `<!--` written inside backticks is documentation.
			INLINE_CODE.lastIndex = opener.index;
			const span = INLINE_CODE.exec(text);
			position = opener.index + (span ? span[0].length : token.length);
		}
	}
	output.push(text.slice(copied));
	return { text: output.join(""), removed };
}

/**
 * Cleans skill text before it is shown or sent: line endings, NUL, invisible characters and hidden comments.
 * The trust hash is taken from the raw text instead, so a change to anything removed here still needs a new review.
 */
export function sanitiseSkillText(raw: string): SanitisedText {
	const normalised = normaliseNewlines(raw).replace(/\0/g, "");
	const invisible = stripInvisible(normalised);
	const comments = stripComments(invisible.text);
	return {
		text: comments.text.trim(),
		invisibleRemoved: invisible.removed,
		commentsRemoved: comments.removed,
		hiddenText: invisible.hiddenText
	};
}
