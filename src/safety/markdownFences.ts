/**
 * One scanner for fenced code, shared by everything that has to know whether a position is inside a code block:
 * block insertion, the result backlink, the conversation export and the heading parser.
 *
 * It follows CommonMark where the details matter for safety: a backtick fence cannot carry backticks in its info
 * string (so ```inline``` is inline code), a closing fence is the same character, at least as long and has nothing
 * after it, a fence may be indented by up to three columns relative to its container, and a fence inside a block
 * quote or list item ends where that container ends. List items are tracked by content column, as a stack, so tab and
 * four-space nested fences are found, a fence indented to an outer item stays in that item after an inner item started,
 * and an over-indented line in a list item stays code.
 */

import { countRun, indentWidth, isBlankLine, stripIndent, type ScanBudget } from "./scan";

export interface FenceSpan {
	/** 0-based line of the opening fence. */
	openLine: number;
	/** 0-based line of the closing fence, or null when the fence was never closed by a fence line. */
	closeLine: number | null;
	/** Last line that belongs to the fence: the closing line, the line before its container ended, or the last line. */
	endLine: number;
	/** True when the fence runs to the end of the text with no closing line. */
	open: boolean;
	marker: "`" | "~";
	length: number;
	info: string;
	language: string;
	/** Number of block quote markers the fence sits in. */
	quoteDepth: number;
	/** Column of the fence characters, counted after any quote markers. */
	fenceIndent: number;
	/** Content column of the list item the fence sits in, or 0 when it is not in a list. */
	containerColumn: number;
}

export interface ScanFencesOptions {
	/** First line to scan, for skipping frontmatter. */
	from?: number;
}

interface OpenFence {
	span: FenceDetails;
	/** Content column of the enclosing list item, or 0 outside lists. */
	containerColumn: number;
}

const FENCE_OPENER = /^(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSER = /^(`{3,}|~{3,})[ \t]*$/;
/** A closing run that every parser takes: no tab after it (marked does not take one), nothing else after it. */
const SPACES_ONLY_CLOSER = /^(`{3,}|~{3,}) *$/;
const LIST_MARKER = /^([-+*]|\d{1,9}[.)])([ \t]+|$)/;
/** A line that starts its own block, so a less indented one can no longer continue a list item's paragraph. */
const BLOCK_START = /^(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|>|(?:[-*_][ \t]*){3,}$)/;

function stripQuoteMarkers(line: string, limit = Number.POSITIVE_INFINITY): { depth: number; rest: string } {
	let rest = line;
	let depth = 0;
	while (depth < limit) {
		const marker = /^ {0,3}>[ ]?/.exec(rest);
		if (!marker) {
			break;
		}
		depth += 1;
		rest = rest.slice(marker[0].length);
	}
	return { depth, rest };
}

function parseOpener(candidate: string): { marker: "`" | "~"; length: number; info: string } | null {
	const match = FENCE_OPENER.exec(stripIndent(candidate));
	if (!match) {
		return null;
	}
	// CommonMark: a backtick fence's info string cannot contain backticks, otherwise the line is inline code.
	if (match[1][0] === "`" && match[2].includes("`")) {
		return null;
	}
	return { marker: match[1][0] as "`" | "~", length: match[1].length, info: match[2].trim() };
}

function closesFence(rest: string, span: FenceDetails, closer: RegExp = FENCE_CLOSER): boolean {
	const match = closer.exec(stripIndent(rest));
	return match !== null && match[1][0] === span.marker && match[1].length >= span.length;
}

/** What a line is to the fence it meets: outside any fence, the opening line, a body line, or an explicit closing line. */
export type FenceLineState = "none" | "open" | "body" | "close";

export interface FenceStep {
	state: FenceLineState;
	/** True when a fence ended just before this line because its quote or list item ended. */
	endedBefore: boolean;
}

export type FenceDetails = Pick<FenceSpan, "marker" | "length" | "info" | "language" | "quoteDepth" | "fenceIndent" | "containerColumn">;

export interface FenceStepper {
	/** Feeds the next line. Lines that are not Markdown (inside a comment or math block) must not be fed. */
	step(line: string): FenceStep;
	/** The fence that is open after the last step, if any. */
	readonly current: FenceDetails | null;
}

/**
 * The scanner as a state machine, for callers that must skip lines of their own (the heading parser does not feed it
 * lines inside comments and math blocks). `scanFences` is built on it.
 */
export function createFenceStepper(): FenceStepper {
	let open: OpenFence | null = null;
	// The list items that are open, outermost first, with the content column of each and the number of quote markers it
	// sits behind. A fence indented to an outer item's column sits in that item even after an item nested inside it
	// started on an earlier line, and an item inside a quote ends with the quote.
	let items: Array<{ column: number; quoteDepth: number }> = [];
	// True when the previous line was paragraph text, which a less indented line can continue lazily. A fence, a blank
	// line or a heading ends that, and so ends the list item the next flush-left line would otherwise have continued.
	let paragraphOpen = false;

	const continueFence = (fence: OpenFence, line: string): "continue" | "close" | "ended" => {
		const { depth, rest } = stripQuoteMarkers(line, fence.span.quoteDepth);
		if (depth < fence.span.quoteDepth) {
			return "ended";
		}
		if (isBlankLine(rest)) {
			return "continue";
		}
		const indent = indentWidth(rest);
		if (fence.containerColumn > 0 && indent < fence.containerColumn) {
			return "ended";
		}
		return indent - fence.containerColumn <= 3 && closesFence(rest, fence.span) ? "close" : "continue";
	};

	return {
		get current(): FenceDetails | null {
			return open ? open.span : null;
		},
		step(line: string): FenceStep {
			let endedBefore = false;
			if (open) {
				const verdict = continueFence(open, line);
				if (verdict !== "ended") {
					const closed = verdict === "close";
					if (closed) {
						open = null;
					}
					return { state: closed ? "close" : "body", endedBefore: false };
				}
				open = null;
				endedBefore = true;
				paragraphOpen = false;
			}

			const { depth, rest } = stripQuoteMarkers(line);
			if (isBlankLine(rest)) {
				paragraphOpen = false;
				return { state: "none", endedBefore };
			}

			const indent = indentWidth(rest);
			const trimmed = stripIndent(rest);
			const marker = LIST_MARKER.exec(trimmed);
			const lazy = items.length > 0 && paragraphOpen && !marker && !BLOCK_START.test(trimmed);
			if (!lazy && items.some((item) => item.quoteDepth > depth)) {
				// A line with fewer quote markers than an item has behind it ends the quote, and the item with it.
				items = items.filter((item) => item.quoteDepth <= depth);
			}
			let candidate = rest;
			let relativeIndent = indent;
			let containerColumn = items[items.length - 1]?.column ?? 0;
			let fenceIndent = indent;
			// The number of open items this line is indented into.
			let itemDepth = items.length;
			while (itemDepth > 0 && indent < items[itemDepth - 1].column) {
				itemDepth -= 1;
			}
			const parentColumn = itemDepth > 0 ? items[itemDepth - 1].column : 0;
			if (marker && indent - parentColumn < 4) {
				// A list item starts here and ends the items nested deeper. Its content begins after the marker and the spaces that follow it (one when there are five or more).
				const gap = marker[2] === "" ? 0 : indentWidth(marker[2]);
				const spaces = gap === 0 || gap >= 5 ? 1 : gap;
				const column = indent + marker[1].length + spaces;
				items = [...items.slice(0, itemDepth), { column, quoteDepth: depth }];
				candidate = trimmed.slice(marker[0].length);
				// Five or more spaces after the marker make what follows an indented code block, whatever it looks like.
				relativeIndent = gap >= 5 ? gap - 1 : 0;
				containerColumn = column;
				fenceIndent = column;
			} else if (itemDepth > 0 && itemDepth === items.length) {
				relativeIndent = indent - containerColumn;
			} else if (lazy) {
				// A less indented line straight after text is a lazy continuation of the item's paragraph.
				relativeIndent = indent;
			} else if (itemDepth > 0) {
				// Indented into an outer item: the items nested inside it have ended.
				items = items.slice(0, itemDepth);
				containerColumn = items[itemDepth - 1].column;
				relativeIndent = indent - containerColumn;
			} else {
				items = [];
				containerColumn = 0;
			}

			const opener = relativeIndent <= 3 ? parseOpener(candidate) : null;
			if (!opener) {
				paragraphOpen = !BLOCK_START.test(trimmed);
				return { state: "none", endedBefore };
			}
			paragraphOpen = false;
			open = {
				span: {
					marker: opener.marker,
					length: opener.length,
					info: opener.info,
					language: opener.info.split(/\s+/)[0] ?? "",
					quoteDepth: depth,
					fenceIndent,
					containerColumn
				},
				containerColumn
			};
			return { state: "open", endedBefore };
		}
	};
}

/** Finds every fenced code block in `lines`, in order. Lines are split on line breaks without their endings. */
export function scanFences(lines: readonly string[], options: ScanFencesOptions = {}): FenceSpan[] {
	const stepper = createFenceStepper();
	const spans: FenceSpan[] = [];
	let pending: FenceSpan | null = null;

	for (let index = options.from ?? 0; index < lines.length; index += 1) {
		const { state, endedBefore } = stepper.step(lines[index]);
		if (endedBefore && pending) {
			spans.push({ ...pending, endLine: index - 1, open: false });
			pending = null;
		}
		if (state === "open" && stepper.current) {
			pending = { ...stepper.current, openLine: index, closeLine: null, endLine: lines.length - 1, open: true };
		} else if (state === "close" && pending) {
			spans.push({ ...pending, closeLine: index, endLine: index, open: false });
			pending = null;
		}
	}
	// A fence still pending here has no closing line and runs to the end of the text.
	if (pending) {
		spans.push(pending);
	}
	return spans;
}

/**
 * First line at or after `from` that could close `fence` for a parser that does not end a fence with its quote or list
 * item (CommonMark does; a lenient parser may not). Parsers disagree on whether a closing fence is indented relative to
 * the container or to the margin, so only a line with at most three columns of indentation after the quote markers
 * counts, which every reading accepts as a closer; a line indented further in is still code. Likewise only a run followed
 * by spaces alone counts: marked also ends a fence at "```~" and CommonMark at "```" plus a tab, each of which the other
 * parser carries on past, so the later of the readings is the first line both would take. Returns `lines.length` when
 * there is none, or when the optional scan budget runs out, which makes the caller read to the end of the text.
 */
export function findLenientFenceCloser(lines: readonly string[], from: number, fence: FenceDetails, budget?: ScanBudget): number {
	for (let index = from; index < lines.length; index += 1) {
		if (budget && !budget.spend(lines[index].length + 1)) {
			return lines.length;
		}
		const { rest } = stripQuoteMarkers(lines[index], fence.quoteDepth);
		if (indentWidth(rest) <= 3 && closesFence(rest, fence, SPACES_ONLY_CLOSER)) {
			return index;
		}
	}
	return lines.length;
}

/**
 * Whether another parser could end a fence the scanner found at a different line than the scanner does.
 *
 * - `none`: no line reads as a closer except the scanner's own, and that one is a closer in every reading.
 * - `early`: a line inside the fence ends it for a parser that takes a longer closing line, because it carries more fence
 *   characters (of either kind) after the run: marked closes at "```~" and at "~~~`", CommonMark does not.
 * - `late`: the scanner's closing line carries a tab after the run, which CommonMark accepts and marked does not, so
 *   that parser carries the fence on to a later closer or to the end of the text.
 *
 * `late` wins when both apply, because it is the reading that makes more text code. A caller that copies a fence through
 * unread should do so only for `none`. Lines are read after quote markers and indentation are taken off, since parsers
 * differ on how much of either a closer may carry, so an indented or quoted look-alike counts too: the cost is a fence
 * whose content is sanitised although it was code. A line that carries text after the run (an opener with an info string)
 * is no closer in any reading and does not count. When the optional budget runs out the answer is `late`.
 */
export type FenceCloserDoubt = "none" | "early" | "late";

export function fenceCloserDoubt(lines: readonly string[], span: FenceSpan, budget?: ScanBudget): FenceCloserDoubt {
	let doubt: FenceCloserDoubt = "none";
	for (let index = span.openLine + 1; index <= span.endLine; index += 1) {
		const line = lines[index];
		if (budget && !budget.spend(line.length + 1)) {
			return "late";
		}
		const shape = readCloserShape(line, span);
		if (!shape.closerLike) {
			continue;
		}
		if (index !== span.closeLine) {
			doubt = "early";
		} else if (shape.tab) {
			return "late";
		}
	}
	return doubt;
}

interface CloserShape {
	/** A run of the fence character at least as long as the opener's, then only fence characters and white space. */
	closerLike: boolean;
	/** True when a tab follows the run. */
	tab: boolean;
}

function readCloserShape(line: string, fence: FenceDetails): CloserShape {
	let cursor = 0;
	while (cursor < line.length && (line[cursor] === " " || line[cursor] === "\t" || line[cursor] === ">")) {
		cursor += 1;
	}
	const run = countRun(line, cursor, fence.marker);
	if (run < fence.length) {
		return { closerLike: false, tab: false };
	}
	let tab = false;
	for (cursor += run; cursor < line.length; cursor += 1) {
		const char = line[cursor];
		if (char === "\t") {
			tab = true;
		} else if (char !== " " && char !== "~" && char !== "`") {
			return { closerLike: false, tab: false };
		}
	}
	return { closerLike: true, tab };
}

/** For each line, whether it belongs to a fenced block (opening line, body or closing line). */
export function fenceLineFlags(lines: readonly string[], options: ScanFencesOptions = {}): boolean[] {
	const flags = lines.map(() => false);
	for (const span of scanFences(lines, options)) {
		for (let line = span.openLine; line <= span.endLine; line += 1) {
			flags[line] = true;
		}
	}
	return flags;
}

function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

/** First line after YAML frontmatter, or 0 when the text has none. */
function afterFrontmatter(lines: readonly string[]): number {
	if (lines[0]?.trim() !== "---") {
		return 0;
	}
	for (let index = 1; index < lines.length; index += 1) {
		if (/^(?:---|\.\.\.)\s*$/.test(lines[index])) {
			return index + 1;
		}
	}
	return 0;
}

function findOpenFence(text: string): FenceSpan | null {
	const lines = splitLines(text);
	const spans = scanFences(lines, { from: afterFrontmatter(lines) });
	const last = spans[spans.length - 1];
	return last?.open ? last : null;
}

export interface OpenFenceOptions {
	/**
	 * Ignore a fence inside a quote or list item. Text appended after a blank line at column zero ends such a container,
	 * and with it the fence, so only a top-level fence swallows what is appended that way.
	 */
	topLevelOnly?: boolean;
}

/** True when the text ends inside a fenced code block, so anything appended directly would become code. */
export function endsInsideOpenFence(text: string, options: OpenFenceOptions = {}): boolean {
	const span = findOpenFence(text);
	return span !== null && (!options.topLevelOnly || (span.quoteDepth === 0 && span.containerColumn === 0));
}

/**
 * Appends a closing fence when the text ends inside a code fence, so one truncated reply cannot turn every later
 * section of an exported note into code. The closing fence uses the opening character, is as long as the opening
 * one, and sits inside the same quote or list item.
 */
export function closeOpenFence(text: string): string {
	const span = findOpenFence(text);
	if (!span) {
		return text;
	}
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const closer = `${"> ".repeat(span.quoteDepth)}${" ".repeat(span.fenceIndent)}${span.marker.repeat(span.length)}`;
	return `${text}${/\n$/.test(text) ? "" : eol}${closer}`;
}

export interface BlockInsertionPlan {
	offset: number;
	text: string;
	/** Set when the note ends inside an unclosed fence, so the block lands in the code. The caller may want to say so. */
	insideOpenFence?: true;
}

export interface BlockInsertionOptions {
	/** Line ending for the separators. Defaults to the note's own. */
	eol?: "\n" | "\r\n";
}

interface Line {
	start: number;
	/** Offset of the end of the line's text, before any carriage return. */
	end: number;
	text: string;
}

function splitLineSpans(text: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf("\n", start);
		const hasCarriageReturn = newline > start && text[newline - 1] === "\r";
		const end = newline === -1 ? text.length : hasCarriageReturn ? newline - 1 : newline;
		lines.push({ start, end, text: text.slice(start, end) });
		if (newline === -1) {
			break;
		}
		start = newline + 1;
	}
	return lines;
}

/** Offset just after the frontmatter block, or 0 when the note has none. */
function frontmatterEnd(lines: Line[]): { offset: number; lineCount: number } {
	if (lines[0]?.text.trimEnd() !== "---") {
		return { offset: 0, lineCount: 0 };
	}
	const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line.text));
	return close === -1 ? { offset: 0, lineCount: 0 } : { offset: lines[close].end, lineCount: close + 1 };
}

/**
 * Plans where a block (an image embed, a link list) can go for a cursor position without splitting a sentence,
 * entering frontmatter or landing inside a code fence. The block goes after the paragraph or block the cursor is in,
 * separated by blank lines, using the note's own line endings.
 */
export function planBlockInsertion(text: string, cursorOffset: number, block: string, options: BlockInsertionOptions = {}): BlockInsertionPlan {
	const eol = options.eol ?? (text.includes("\r\n") ? "\r\n" : "\n");
	const lines = splitLineSpans(text);
	const clamped = Math.max(0, Math.min(text.length, cursorOffset));
	const frontmatter = frontmatterEnd(lines);
	let offset = Math.max(clamped, frontmatter.offset);
	let lineIndex = lines.findIndex((line) => offset >= line.start && offset <= line.end);
	if (lineIndex === -1) {
		lineIndex = lines.length - 1;
	}

	const spans = scanFences(lines.map((line) => line.text), { from: frontmatter.lineCount });
	const inFence = new Set<number>();
	for (const span of spans) {
		for (let line = span.openLine; line <= span.endLine; line += 1) {
			inFence.add(line);
		}
	}
	const containing = spans.find((span) => lineIndex >= span.openLine && lineIndex <= span.endLine);

	if (containing) {
		lineIndex = containing.endLine;
		offset = lines[lineIndex].end;
	} else if (offset === frontmatter.offset && frontmatter.offset > 0 && clamped <= frontmatter.offset) {
		// Frontmatter is its own block, so the block follows it directly.
		offset = frontmatter.offset;
	} else if (lines[lineIndex].text.trim() !== "") {
		let last = lineIndex;
		while (last + 1 < lines.length && lines[last + 1].text.trim() !== "" && !inFence.has(last + 1)) {
			last += 1;
		}
		offset = lines[last].end;
	} else {
		offset = lines[lineIndex].start;
	}

	const before = text.slice(0, offset);
	const rest = text.slice(offset);
	const prefix = before === "" || /\n\r?\n$/.test(before) ? "" : /\n$/.test(before) ? eol : `${eol}${eol}`;
	// The note's final line break already ends the block, so it is not doubled.
	const suffix = /^(?:\r?\n){2}/.test(rest) || /^\r?\n$/.test(rest) ? "" : eol;
	const plan: BlockInsertionPlan = { offset, text: `${prefix}${block}${suffix}` };
	return containing?.open ? { ...plan, insideOpenFence: true } : plan;
}
