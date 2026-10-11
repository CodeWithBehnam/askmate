import type { FrontmatterBlock, MarkdownHeadingSection } from "../shared/types";

const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface OpenFence {
	char: string;
	length: number;
}

function getFrontmatterEndLine(lines: string[]): number {
	if (lines[0]?.trim() !== "---") {
		return 0;
	}
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index].trim() === "---") {
			return index + 1;
		}
	}
	return 0;
}

function readFenceOpen(line: string): OpenFence | null {
	const match = line.match(FENCE_OPEN_PATTERN);
	if (!match) {
		return null;
	}
	const fence = match[1];
	// CommonMark: a backtick fence's info string cannot contain backticks, otherwise the line is inline code.
	if (fence[0] === "`" && match[2].includes("`")) {
		return null;
	}
	return { char: fence[0], length: fence.length };
}

function closesFence(line: string, fence: OpenFence): boolean {
	const trimmed = line.trim();
	if (!/^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) {
		return false;
	}
	return trimmed[0] === fence.char && trimmed.length >= fence.length;
}

const ATX_HEADING_PATTERN = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
// CommonMark: the optional closing "#" run must follow whitespace, so "# Learning C#" keeps its "#".
const ATX_CLOSING_SEQUENCE_PATTERN = /(?:^|[ \t]+)#+[ \t]*$/;
const SETEXT_UNDERLINE_PATTERN = /^ {0,3}(=+|-+)[ \t]*$/;
// A "---" after a blank line is a thematic break, so only a directly preceding paragraph line may become a setext title.
const NON_PARAGRAPH_LINE_PATTERN = /^(?:\s*$| {4,}|\s*>|\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)|\s*\||\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$)/;

type BlockOpener = "html-comment" | "percent-comment" | "math";

function isParagraphLine(line: string): boolean {
	return !NON_PARAGRAPH_LINE_PATTERN.test(line) && !line.includes("|");
}

function countOccurrences(line: string, token: string): number {
	return line.split(token).length - 1;
}

/** Returns the opener of a multi-line comment or math block that starts on this line, "none" if it opens and closes here, or null. */
function readBlockOpen(line: string): BlockOpener | "none" | null {
	const trimmed = line.trim();
	if (trimmed.startsWith("<!--")) {
		return trimmed.indexOf("-->", 4) === -1 ? "html-comment" : "none";
	}
	if (trimmed.startsWith("%%")) {
		return countOccurrences(trimmed, "%%") % 2 === 1 ? "percent-comment" : "none";
	}
	if (trimmed.startsWith("$$")) {
		return countOccurrences(trimmed, "$$") % 2 === 1 ? "math" : "none";
	}
	return null;
}

function closesBlock(line: string, opener: BlockOpener): boolean {
	switch (opener) {
		case "html-comment":
			return line.includes("-->");
		case "percent-comment":
			return line.includes("%%");
		case "math":
			return line.includes("$$");
	}
}

export function parseMarkdownHeadingSections(markdown: string): MarkdownHeadingSection[] {
	const lines = markdown.split(/\r?\n/);
	const sections: MarkdownHeadingSection[] = [];
	const stack: MarkdownHeadingSection[] = [];
	let openFence: OpenFence | null = null;
	let openBlock: BlockOpener | null = null;
	// First line of the paragraph that directly precedes the current line, or -1 when there is none.
	let paragraphStart = -1;

	const addHeading = (level: number, title: string, headingLine: number, bodyStartLine: number): void => {
		while (stack.length > 0 && stack[stack.length - 1].level >= level) {
			const completed = stack.pop();
			if (completed) {
				completed.endLineExclusive = headingLine;
			}
		}
		// An empty heading still closes the sections it interrupts, but it cannot be targeted or appear in a path.
		if (!title) {
			return;
		}

		const path = [...stack.map((section) => section.title), title].join(" > ");
		const section: MarkdownHeadingSection = {
			level,
			title,
			path,
			headingLine,
			bodyStartLine,
			endLineExclusive: lines.length
		};
		sections.push(section);
		stack.push(section);
	};

	// Lines inside YAML frontmatter, fenced code or comments and math blocks are not headings.
	for (let lineIndex = getFrontmatterEndLine(lines); lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		if (openFence) {
			if (closesFence(line, openFence)) {
				openFence = null;
			}
			continue;
		}
		if (openBlock) {
			if (closesBlock(line, openBlock)) {
				openBlock = null;
			}
			continue;
		}
		const fence = readFenceOpen(line);
		if (fence) {
			openFence = fence;
			paragraphStart = -1;
			continue;
		}
		const blockOpener = readBlockOpen(line);
		if (blockOpener) {
			openBlock = blockOpener === "none" ? null : blockOpener;
			paragraphStart = -1;
			continue;
		}

		const underline = line.match(SETEXT_UNDERLINE_PATTERN);
		if (underline && paragraphStart >= 0) {
			const title = lines.slice(paragraphStart, lineIndex).map((part) => part.trim()).join(" ");
			addHeading(underline[1][0] === "=" ? 1 : 2, title, paragraphStart, lineIndex + 1);
			paragraphStart = -1;
			continue;
		}

		const atx = line.match(ATX_HEADING_PATTERN);
		if (atx) {
			const title = (atx[2] ?? "").replace(ATX_CLOSING_SEQUENCE_PATTERN, "").trim();
			addHeading(atx[1].length, title, lineIndex, lineIndex + 1);
			paragraphStart = -1;
			continue;
		}

		if (!isParagraphLine(line)) {
			paragraphStart = -1;
		} else if (paragraphStart < 0) {
			paragraphStart = lineIndex;
		}
	}

	return sections;
}

export function splitMarkdownFrontmatter(markdown: string): FrontmatterBlock {
	const lines = markdown.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") {
		return { exists: false, malformed: false, frontmatter: "", body: markdown, endLineExclusive: 0 };
	}
	// Keep the note's own line endings so a frontmatter-preserving Apply does not silently convert CRLF notes.
	const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index].trim() === "---") {
			return {
				exists: true,
				malformed: false,
				frontmatter: lines.slice(0, index + 1).join(eol),
				body: lines.slice(index + 1).join(eol).replace(/^(?:\r?\n)+/, ""),
				endLineExclusive: index + 1
			};
		}
	}
	// An opening "---" with no closing line is either broken YAML or a thematic break. Keep the whole text as body
	// so callers that strip or replace frontmatter can never discard note content.
	return { exists: true, malformed: true, frontmatter: "", body: markdown, endLineExclusive: 0 };
}
