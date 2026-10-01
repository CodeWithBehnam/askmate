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

export function parseMarkdownHeadingSections(markdown: string): MarkdownHeadingSection[] {
	const lines = markdown.split(/\r?\n/);
	const sections: MarkdownHeadingSection[] = [];
	const stack: MarkdownHeadingSection[] = [];
	let openFence: OpenFence | null = null;

	// Lines inside YAML frontmatter or fenced code (for example "# comment" in a bash block) are not headings.
	for (let lineIndex = getFrontmatterEndLine(lines); lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		if (openFence) {
			if (closesFence(line, openFence)) {
				openFence = null;
			}
			continue;
		}
		const fence = readFenceOpen(line);
		if (fence) {
			openFence = fence;
			continue;
		}

		const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (!match) {
			continue;
		}

		const level = match[1].length;
		const title = match[2].trim();
		while (stack.length > 0 && stack[stack.length - 1].level >= level) {
			const completed = stack.pop();
			if (completed) {
				completed.endLineExclusive = lineIndex;
			}
		}

		const path = [...stack.map((section) => section.title), title].join(" > ");
		const section: MarkdownHeadingSection = {
			level,
			title,
			path,
			headingLine: lineIndex,
			bodyStartLine: lineIndex + 1,
			endLineExclusive: lines.length
		};
		sections.push(section);
		stack.push(section);
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
