import { endsInsideOpenFence, fenceLineFlags } from "../safety/markdownFences";

export const RESULT_BACKLINK_HEADING = "## AskMate results";

export interface TextInsertion {
	offset: number;
	text: string;
}

const RESULT_HEADING_LINE = /^ {0,3}## AskMate results[ \t]*$/;
const LIST_ITEM_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;

interface LineSpan {
	text: string;
	start: number;
	/** Offset just past this line's newline, or the end of the content for the last line. */
	next: number;
}

function splitLineSpans(content: string): LineSpan[] {
	const spans: LineSpan[] = [];
	let start = 0;
	while (start <= content.length) {
		const newline = content.indexOf("\n", start);
		const end = newline === -1 ? content.length : newline;
		spans.push({ text: content.slice(start, end).replace(/\r$/, ""), start, next: newline === -1 ? content.length : newline + 1 });
		if (newline === -1) {
			break;
		}
		start = newline + 1;
	}
	return spans;
}

function findResultHeadingIndex(lines: LineSpan[]): number {
	// The shared scanner knows quote, list and tab-indented fences, so a heading inside one is never matched.
	const inFence = fenceLineFlags(lines.map((line) => line.text));
	return lines.findIndex((line, index) => !inFence[index] && RESULT_HEADING_LINE.test(line.text));
}

export type ResultBacklinkPlan =
	| { kind: "insert"; insertion: TextInsertion }
	/** The exact bullet line is already in the note. */
	| { kind: "present" }
	/** The note ends inside an unclosed top-level code fence, so a heading appended at the end would become code. */
	| { kind: "inside-open-fence" };

/**
 * Plans where the result backlink bullet goes, as a single insertion so it can be applied through an open editor or
 * inside an atomic vault write. The heading only matches as a whole line outside code fences, and existing text and
 * line endings are never rewritten. When the note ends inside an unclosed fence there is no safe place to append, and
 * the plan says so instead of writing into the code; the fence is not closed on the user's behalf.
 */
export function planResultBacklink(content: string, bullet: string): ResultBacklinkPlan {
	const lines = splitLineSpans(content);
	if (lines.some((line) => line.text === bullet)) {
		return { kind: "present" };
	}
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const headingIndex = findResultHeadingIndex(lines);

	if (headingIndex === -1) {
		// A heading appended after a blank line ends a quote or list item and its fence, but not a top-level fence.
		if (endsInsideOpenFence(content, { topLevelOnly: true })) {
			return { kind: "inside-open-fence" };
		}
		const separator = content.length === 0 || content.endsWith(`${eol}${eol}`)
			? ""
			: content.endsWith(eol) ? eol : `${eol}${eol}`;
		return { kind: "insert", insertion: { offset: content.length, text: `${separator}${RESULT_BACKLINK_HEADING}${eol}${eol}${bullet}${eol}` } };
	}

	const heading = lines[headingIndex];
	if (heading.next === content.length && !content.endsWith("\n")) {
		return { kind: "insert", insertion: { offset: content.length, text: `${eol}${eol}${bullet}${eol}` } };
	}
	let index = headingIndex + 1;
	while (index < lines.length && lines[index].text.trim() === "" && lines[index].start < content.length) {
		index += 1;
	}
	const skippedBlankLine = index > headingIndex + 1;
	const following = index < lines.length && lines[index].start < content.length ? lines[index] : null;
	const offset = following ? following.start : content.length;
	const prefix = skippedBlankLine ? "" : eol;
	const suffix = following && !LIST_ITEM_LINE.test(following.text) ? `${eol}${eol}` : eol;
	return { kind: "insert", insertion: { offset, text: `${prefix}${bullet}${suffix}` } };
}

/** The insertion for {@link planResultBacklink}, or null when there is nothing to insert: the bullet is present, or the note ends inside an open fence. */
export function planResultBacklinkInsertion(content: string, bullet: string): TextInsertion | null {
	const plan = planResultBacklink(content, bullet);
	return plan.kind === "insert" ? plan.insertion : null;
}

export function applyTextInsertion(content: string, insertion: TextInsertion): string {
	return `${content.slice(0, insertion.offset)}${insertion.text}${content.slice(insertion.offset)}`;
}
