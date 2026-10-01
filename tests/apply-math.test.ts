import { describe, expect, test } from "bun:test";
import { parseMarkdownHeadingSections, splitMarkdownFrontmatter } from "../src/output/applyMath";

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
