import { describe, expect, test } from "bun:test";
import { parseMarkdownHeadingSections, splitMarkdownFrontmatter } from "../src/output/applyMath";

describe("parseMarkdownHeadingSections", () => {
	test("builds nested heading paths", () => {
		const md = ["# Parent", "body", "## Child", "more", "# Other"].join("\n");
		const sections = parseMarkdownHeadingSections(md);
		expect(sections.map((s) => s.path)).toEqual(["Parent", "Parent > Child", "Other"]);
		expect(sections[1].bodyStartLine).toBe(3);
	});
});

describe("splitMarkdownFrontmatter", () => {
	test("splits closed YAML frontmatter", () => {
		const md = ["---", "title: demo", "---", "", "Body"].join("\n");
		const block = splitMarkdownFrontmatter(md);
		expect(block.exists).toBe(true);
		expect(block.malformed).toBe(false);
		expect(block.body).toContain("Body");
		expect(block.frontmatter).toContain("title: demo");
	});

	test("marks unclosed frontmatter as malformed", () => {
		const block = splitMarkdownFrontmatter("---\ntitle: x\nBody");
		expect(block.exists).toBe(true);
		expect(block.malformed).toBe(true);
	});
});
