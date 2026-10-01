export const RESULT_BACKLINK_HEADING = "## AskMate results";

export interface TextInsertion {
	offset: number;
	text: string;
}

const RESULT_HEADING_LINE = /^ {0,3}## AskMate results[ \t]*$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
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
	let fence: { char: string; length: number } | null = null;
	for (const [index, line] of lines.entries()) {
		const fenceMatch = FENCE_LINE.exec(line.text);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			if (!fence) {
				fence = { char: marker[0], length: marker.length };
			} else if (marker[0] === fence.char && marker.length >= fence.length && line.text.trim() === marker) {
				fence = null;
			}
			continue;
		}
		if (!fence && RESULT_HEADING_LINE.test(line.text)) {
			return index;
		}
	}
	return -1;
}

/**
 * Plans where the result backlink bullet goes, as a single insertion so it can be applied through an open editor or
 * inside an atomic vault write. Returns null when the exact bullet line is already present. The heading only matches
 * as a whole line outside code fences, and existing text and line endings are never rewritten.
 */
export function planResultBacklinkInsertion(content: string, bullet: string): TextInsertion | null {
	const lines = splitLineSpans(content);
	if (lines.some((line) => line.text === bullet)) {
		return null;
	}
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const headingIndex = findResultHeadingIndex(lines);

	if (headingIndex === -1) {
		const separator = content.length === 0 || content.endsWith(`${eol}${eol}`)
			? ""
			: content.endsWith(eol) ? eol : `${eol}${eol}`;
		return { offset: content.length, text: `${separator}${RESULT_BACKLINK_HEADING}${eol}${eol}${bullet}${eol}` };
	}

	const heading = lines[headingIndex];
	if (heading.next === content.length && !content.endsWith("\n")) {
		return { offset: content.length, text: `${eol}${eol}${bullet}${eol}` };
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
	return { offset, text: `${prefix}${bullet}${suffix}` };
}

export function applyTextInsertion(content: string, insertion: TextInsertion): string {
	return `${content.slice(0, insertion.offset)}${insertion.text}${content.slice(insertion.offset)}`;
}
