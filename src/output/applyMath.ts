import type { FrontmatterBlock, MarkdownHeadingSection } from "../shared/types";

export function parseMarkdownHeadingSections(markdown: string): MarkdownHeadingSection[] {
	const lines = markdown.split(/\r?\n/);
	const sections: MarkdownHeadingSection[] = [];
	const stack: MarkdownHeadingSection[] = [];

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const match = lines[lineIndex].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
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
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index].trim() === "---") {
			return {
				exists: true,
				malformed: false,
				frontmatter: lines.slice(0, index + 1).join("\n"),
				body: lines.slice(index + 1).join("\n").replace(/^\n+/, ""),
				endLineExclusive: index + 1
			};
		}
	}
	return { exists: true, malformed: true, frontmatter: markdown, body: "", endLineExclusive: lines.length };
}
