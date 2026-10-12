import { createFenceStepper } from "../safety/markdownFences";
import type { FrontmatterBlock, MarkdownHeadingSection } from "../shared/types";

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

/**
 * Returns the opener of a multi-line comment or math block that starts on this line, "none" if it opens and closes here,
 * or null. An opener sits at column zero to three: a more indented line is code, not a comment.
 */
function readBlockOpen(line: string): BlockOpener | "none" | null {
	const unindented = line.replace(/^ {0,3}/, "");
	if (unindented.startsWith(" ") || unindented.startsWith("\t")) {
		return null;
	}
	const trimmed = unindented.trim();
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

const ATX_HEADING_TEXT_PATTERN = /^ {0,3}#{1,6}[ \t]+\S/;

interface HeadingScan {
	sections: MarkdownHeadingSection[];
	/** Lines that look like headings but sit inside a comment or math block that never closes. */
	hiddenHeadingLines: number[];
}

function scanHeadings(markdown: string): HeadingScan {
	const lines = markdown.split(/\r?\n/);
	const sections: MarkdownHeadingSection[] = [];
	const stack: MarkdownHeadingSection[] = [];
	const fences = createFenceStepper();
	let openBlock: BlockOpener | null = null;
	let headingLikeInBlock: number[] = [];
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

	// Lines inside YAML frontmatter, fenced code or comments and math blocks are not headings. A comment or math block
	// is opaque, so its lines never reach the fence tracker, and a fence is opaque to comment and math openers.
	for (let lineIndex = getFrontmatterEndLine(lines); lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		if (openBlock) {
			if (ATX_HEADING_TEXT_PATTERN.test(line)) {
				headingLikeInBlock.push(lineIndex);
			}
			if (closesBlock(line, openBlock)) {
				openBlock = null;
				headingLikeInBlock = [];
			}
			continue;
		}
		if (fences.step(line).state !== "none") {
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

	return { sections, hiddenHeadingLines: openBlock ? headingLikeInBlock : [] };
}

export function parseMarkdownHeadingSections(markdown: string): MarkdownHeadingSection[] {
	return scanHeadings(markdown).sections;
}

/**
 * Lines inside `section` that look like headings but were swallowed by an unclosed comment or math block. Such a
 * section reaches the end of the note, so replacing it would delete the headings after it: callers should force a
 * preview whenever this is not empty.
 */
export function findSectionHiddenHeadings(markdown: string, section: MarkdownHeadingSection): number[] {
	return scanHeadings(markdown).hiddenHeadingLines.filter((line) => line > section.headingLine && line < section.endLineExclusive);
}

export interface FrontmatterSplitOptions {
	/**
	 * Accept the leading block as frontmatter only when every non-blank line looks like YAML. This is the default, so a
	 * reply that opens with a thematic break is not mistaken for frontmatter. Pass false for a note's own frontmatter,
	 * which must be preserved even when it is not valid YAML.
	 */
	requireYaml?: boolean;
}

// A mapping key, optionally quoted. Keys may hold spaces ("date created"), but not start with a list dash or comment mark.
const YAML_KEY_PATTERN = /^(?:"[^"]*"|'[^']*'|[^\s#:"'-][^:]*?):(?:\s|$)/;

/** True for a block of lines that reads as a YAML mapping: a key first, then keys, list items, comments and indented lines. */
function looksLikeYaml(block: readonly string[]): boolean {
	const meaningful = block.filter((line) => line.trim() !== "");
	if (meaningful.length === 0) {
		return true;
	}
	let sawKey = false;
	for (const line of meaningful) {
		if (/^\s*#/.test(line)) {
			continue;
		}
		if (YAML_KEY_PATTERN.test(line)) {
			sawKey = true;
		} else if (!sawKey || !(/^\s+\S/.test(line) || /^-(?:\s|$)/.test(line))) {
			return false;
		}
	}
	return sawKey;
}

export function splitMarkdownFrontmatter(markdown: string, options: FrontmatterSplitOptions = {}): FrontmatterBlock {
	const lines = markdown.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") {
		return { exists: false, malformed: false, frontmatter: "", body: markdown, endLineExclusive: 0 };
	}
	// Keep the note's own line endings so a frontmatter-preserving Apply does not silently convert CRLF notes.
	const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index].trim() === "---") {
			if ((options.requireYaml ?? true) && !looksLikeYaml(lines.slice(1, index))) {
				// Two thematic breaks around prose, not a property block: the whole text is body.
				return { exists: false, malformed: false, frontmatter: "", body: markdown, endLineExclusive: 0 };
			}
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
