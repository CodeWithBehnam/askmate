import { describe, expect, test } from "bun:test";
import { findSectionHiddenHeadings, parseMarkdownHeadingSections, splitMarkdownFrontmatter } from "../src/output/applyMath";
import { spliceHeadingSectionBody } from "../src/output/sectionSplice";

describe("parseMarkdownHeadingSections", () => {
	test("builds nested heading paths", () => {
		const md = ["# Parent", "body", "## Child", "more", "# Other"].join("\n");
		const sections = parseMarkdownHeadingSections(md);
		expect(sections.map((s) => s.path)).toEqual(["Parent", "Parent > Child", "Other"]);
		expect(sections[1].bodyStartLine).toBe(3);
	});

	test.each([
		["backtick fence", ["# Setup", "```bash", "# install deps", "npm i", "```", "after", "# Next"]],
		["tilde fence", ["# Setup", "~~~", "# not a heading", "~~~", "after", "# Next"]],
		["longer closing fence", ["# Setup", "```", "# inside", "````", "after", "# Next"]],
		["indented fence", ["# Setup", "   ```js", "# inside", "   ```", "# Next"]]
	])("ignores '#' lines inside a %s", (_name: string, lines: string[]) => {
		const sections = parseMarkdownHeadingSections(lines.join("\n"));
		expect(sections.map((s) => s.title)).toEqual(["Setup", "Next"]);
		expect(sections[0].endLineExclusive).toBe(lines.indexOf("# Next"));
	});

	test("a fence closed by a different character or a shorter run stays open", () => {
		const lines = ["# Setup", "````", "~~~", "```", "# inside", "````", "# Next"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((s) => s.title)).toEqual(["Setup", "Next"]);
	});

	test("an unclosed fence hides every later '#' line", () => {
		const lines = ["# Setup", "```", "# inside", "# still inside"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((s) => s.title)).toEqual(["Setup"]);
	});

	test("inline backticks with a backtick info string do not open a fence", () => {
		const lines = ["# Setup", "```a`b```", "# Next"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((s) => s.title)).toEqual(["Setup", "Next"]);
	});

	test("ignores '#' lines inside YAML frontmatter", () => {
		const lines = ["---", "# yaml comment", "title: demo", "---", "# Real"];
		const sections = parseMarkdownHeadingSections(lines.join("\n"));
		expect(sections.map((s) => s.title)).toEqual(["Real"]);
		expect(sections[0].headingLine).toBe(4);
	});

	test("strips closing hashes, allows up to three leading spaces and skips tags", () => {
		const lines = ["## Title ##", "   ### Indented", "#tag is not a heading", "    # four spaces is code"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((s) => s.title)).toEqual(["Title", "Indented"]);
	});

	test("keeps duplicate titles distinct by path and line", () => {
		const lines = ["# A", "## Notes", "# B", "## Notes"];
		const sections = parseMarkdownHeadingSections(lines.join("\n"));
		expect(sections.filter((s) => s.title === "Notes").map((s) => s.path)).toEqual(["A > Notes", "B > Notes"]);
	});

	test("handles CRLF line endings", () => {
		const sections = parseMarkdownHeadingSections("# One\r\nbody\r\n## Two\r\n");
		expect(sections.map((s) => s.path)).toEqual(["One", "One > Two"]);
	});
});

describe("splitMarkdownFrontmatter", () => {
	test("splits closed YAML frontmatter", () => {
		const md = ["---", "title: demo", "---", "", "Body"].join("\n");
		const block = splitMarkdownFrontmatter(md);
		expect(block.exists).toBe(true);
		expect(block.malformed).toBe(false);
		expect(block.body).toBe("Body");
		expect(block.frontmatter).toBe("---\ntitle: demo\n---");
		expect(block.endLineExclusive).toBe(3);
	});

	test("unclosed frontmatter is malformed and keeps the whole text as body", () => {
		const block = splitMarkdownFrontmatter("---\ntitle: x\nBody");
		expect(block.exists).toBe(true);
		expect(block.malformed).toBe(true);
		expect(block.frontmatter).toBe("");
		expect(block.body).toBe("---\ntitle: x\nBody");
	});

	test("a leading thematic break never loses the text after it", () => {
		const text = "---\n\nA rewritten paragraph.\n\nAnother paragraph.";
		expect(splitMarkdownFrontmatter(text).body).toBe(text);
	});

	test("keeps CRLF line endings", () => {
		const block = splitMarkdownFrontmatter("---\r\ntitle: demo\r\n---\r\n\r\nBody\r\nMore");
		expect(block.frontmatter).toBe("---\r\ntitle: demo\r\n---");
		expect(block.body).toBe("Body\r\nMore");
	});

	test("a reply that opens with a thematic break and has a second one is body, not frontmatter", () => {
		const text = "---\n\n# New title\n\nIntro text\n\n---\n\n## Section\n\nMore";
		expect(splitMarkdownFrontmatter(text)).toEqual({ exists: false, malformed: false, frontmatter: "", body: text, endLineExclusive: 0 });
		const crlf = text.replace(/\n/g, "\r\n");
		expect(splitMarkdownFrontmatter(crlf)).toEqual({ exists: false, malformed: false, frontmatter: "", body: crlf, endLineExclusive: 0 });
	});

	test("a block with no key, or one of only comments or list items, is not frontmatter", () => {
		for (const middle of ["# Just a heading", "- one\n- two", "plain text line", "# a comment\n# another"]) {
			const text = `---\n${middle}\n---\nBody`;
			expect({ middle, exists: splitMarkdownFrontmatter(text).exists }).toEqual({ middle, exists: false });
		}
	});

	test("keys, lists, comments, continuation lines and block scalars are frontmatter", () => {
		const text = ["---", "title: \"Plan: Q3\"", "# a comment", "tags:", "  - a", "- b", "summary: |", "  Long text", "", "  more", "---", "Body"].join("\n");
		expect(splitMarkdownFrontmatter(text)).toMatchObject({ exists: true, malformed: false, body: "Body" });
	});

	test("an unfenced diagram header with a title is read as frontmatter, which is why diagrams are always fenced", () => {
		const block = splitMarkdownFrontmatter("---\ntitle: Plan\n---\nflowchart TD\n  A --> B");
		expect(block).toMatchObject({ exists: true, body: "flowchart TD\n  A --> B" });
	});

	test("the YAML check can be turned off for a note's own frontmatter", () => {
		const text = "---\nnot yaml at all\nstill not\n---\nBody";
		expect(splitMarkdownFrontmatter(text).exists).toBe(false);
		expect(splitMarkdownFrontmatter(text, { requireYaml: false })).toMatchObject({ exists: true, malformed: false, body: "Body" });
	});

	test("returns the note unchanged when there is no frontmatter", () => {
		const block = splitMarkdownFrontmatter("Body only");
		expect(block).toEqual({ exists: false, malformed: false, frontmatter: "", body: "Body only", endLineExclusive: 0 });
	});

	test("empty frontmatter and empty body", () => {
		const block = splitMarkdownFrontmatter("---\n---");
		expect(block.exists).toBe(true);
		expect(block.malformed).toBe(false);
		expect(block.body).toBe("");
	});
});

describe("parseMarkdownHeadingSections edge cases", () => {
	test("recognises setext headings so the previous section ends before them", () => {
		const lines = ["## A", "old", "", "B", "---", "body B", "", "C", "===", "body C"];
		const sections = parseMarkdownHeadingSections(lines.join("\n"));
		expect(sections.map((s) => [s.level, s.title])).toEqual([[2, "A"], [2, "B"], [1, "C"]]);
		expect(sections[0].endLineExclusive).toBe(3);
		expect(sections[1].bodyStartLine).toBe(5);
		expect(sections[1].endLineExclusive).toBe(7);
	});

	test("a '---' after a blank line is a thematic break, not a setext underline", () => {
		const lines = ["# A", "text", "", "---", "more"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((s) => s.title)).toEqual(["A"]);
	});

	test("list items, quotes and tables are not setext titles", () => {
		const lines = ["# A", "- item", "---", "> quote", "---", "| a | b |", "---"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((s) => s.title)).toEqual(["A"]);
	});

	test("keeps a trailing '#' that is part of the title", () => {
		const sections = parseMarkdownHeadingSections(["# Learning C#", "## F#", "### Closed ###"].join("\n"));
		expect(sections.map((s) => s.title)).toEqual(["Learning C#", "F#", "Closed"]);
	});

	test("empty headings end sections but are not targetable", () => {
		const sections = parseMarkdownHeadingSections(["## Real", "a", "##  ", "b", "## ##", "c", "## Next"].join("\n"));
		expect(sections.map((s) => s.title)).toEqual(["Real", "Next"]);
		expect(sections[0].endLineExclusive).toBe(2);
		expect(sections[1].path).toBe("Next");
	});

	test("ignores headings inside HTML comments, %% comments and math blocks", () => {
		const lines = ["# A", "<!--", "# hidden", "-->", "%%", "# off", "%%", "$$", "# x", "$$", "# B"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((s) => s.title)).toEqual(["A", "B"]);
	});

	test("single-line comments do not hide later headings", () => {
		const lines = ["# A", "<!-- note -->", "%% note %%", "$$x$$", "# B"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((s) => s.title)).toEqual(["A", "B"]);
	});
});

describe("parseMarkdownHeadingSections: fences nested in lists and quotes", () => {
	const note = (indent: string, commentLine = "%% a comment"): string[] => [
		"# A", "", "- step one", `${indent}\`\`\`mermaid`, `${indent}${commentLine}`, `${indent}graph TD`, `${indent}  X-->Y`, `${indent}\`\`\``, "",
		"# B", "", "text B", "", "# C", "", "text C"
	];

	test.each([
		["a tab", "\t"],
		["four spaces", "    "],
		["three spaces", "   "],
		["two spaces", "  "]
	])("a list-nested fence indented with %s and holding a %% comment does not swallow later headings", (_name: string, indent: string) => {
		const lines = note(indent);
		const sections = parseMarkdownHeadingSections(lines.join("\n"));
		expect(sections.map((section) => section.title)).toEqual(["A", "B", "C"]);
		expect(sections[0].endLineExclusive).toBe(lines.indexOf("# B"));
	});

	test.each([
		["a MATLAB section comment", "%% Section 1"],
		["an odd number of dollar signs", "$$ x"],
		["an unclosed HTML comment", "<!-- start"]
	])("%s inside a nested fence is code, not a block opener", (_name: string, line: string) => {
		const sections = parseMarkdownHeadingSections(note("\t", line).join("\n"));
		expect(sections.map((section) => section.title)).toEqual(["A", "B", "C"]);
	});

	test("a section Apply on such a note keeps every other section", () => {
		const content = note("\t").join("\n");
		const sectionA = parseMarkdownHeadingSections(content)[0];
		const result = spliceHeadingSectionBody(content, sectionA, "REWRITTEN A").next;
		expect(result).toContain("REWRITTEN A");
		expect(result).toContain("# B\n\ntext B\n\n# C\n\ntext C");
	});

	test("quoted and callout fences with comments do not swallow later headings", () => {
		const lines = ["# A", "> [!example]", "> ```mermaid", "> %% note", "> graph TD", "> ```", "", "# B"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((section) => section.title)).toEqual(["A", "B"]);
	});

	test("an over-indented comment line outside a fence is not a block opener", () => {
		const lines = ["# A", "text", "    %% indented code, not a comment", "# B"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((section) => section.title)).toEqual(["A", "B"]);
	});

	test("a comment or math block opener still works at columns zero to three", () => {
		const lines = ["# A", "   %%", "# hidden", "%%", "# B"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((section) => section.title)).toEqual(["A", "B"]);
	});

	test("a fence-looking line inside a comment does not open a fence", () => {
		const lines = ["# A", "%%", "```js", "%%", "# B", "```", "# C"];
		// The comment hides its fence line, so B is a heading; the later bare fence opens a real fence that hides C.
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((section) => section.title)).toEqual(["A", "B"]);
	});

	test("a list fence ends with its list item", () => {
		const lines = ["# A", "- item", "  ```js", "  code", "# B"];
		expect(parseMarkdownHeadingSections(lines.join("\n")).map((section) => section.title)).toEqual(["A", "B"]);
	});
});

describe("findSectionHiddenHeadings", () => {
	test("reports headings swallowed by an unclosed comment or math block inside the section's range", () => {
		const lines = ["# A", "", "text", "", "%%", "", "# B", "", "text B"];
		const content = lines.join("\n");
		const sections = parseMarkdownHeadingSections(content);
		expect(sections.map((section) => section.title)).toEqual(["A"]);
		expect(sections[0].endLineExclusive).toBe(lines.length);
		expect(findSectionHiddenHeadings(content, sections[0])).toEqual([6]);
		expect(findSectionHiddenHeadings("# A\n\n$$\n## B\n", parseMarkdownHeadingSections("# A\n\n$$\n## B\n")[0])).toEqual([3]);
		expect(findSectionHiddenHeadings("# A\n<!--\n# B\n", parseMarkdownHeadingSections("# A\n<!--\n# B\n")[0])).toEqual([2]);
	});

	test("reports nothing for closed comments, code and ordinary sections", () => {
		for (const content of ["# A\n%%\n# hidden\n%%\n# B\n", "# A\n```\n# code\n```\n", "# A\ntext\n# B\nmore\n", "# A\n- item\n\t```mermaid\n\t%% x\n\t# not a heading\n\t```\n"]) {
			for (const section of parseMarkdownHeadingSections(content)) {
				expect({ content, hidden: findSectionHiddenHeadings(content, section) }).toEqual({ content, hidden: [] });
			}
		}
	});

	test("only counts hidden headings inside the section asked about", () => {
		const content = "# A\n\ntext\n\n# B\n\n%%\n# hidden\n";
		const [first, second] = parseMarkdownHeadingSections(content);
		expect(findSectionHiddenHeadings(content, first)).toEqual([]);
		expect(findSectionHiddenHeadings(content, second)).toEqual([7]);
	});
});
