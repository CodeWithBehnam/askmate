import { describe, expect, test } from "bun:test";
import { closeOpenFence, conversationToMarkdown, hasExportableTurns, resolveExportTitle } from "../src/output/conversationExport";
import type { ChatMessage } from "../src/shared/types";

const meta = { title: "Budget review", exportedAt: "2026-10-11T12:00:00.000Z", providerName: "OpenAI", model: "gpt-5.5" };

describe("conversationToMarkdown", () => {
	test("an empty conversation has no exportable turns and only a header", () => {
		expect(hasExportableTurns([])).toBe(false);
		expect(hasExportableTurns([{ role: "system", text: "Chat cleared." }])).toBe(false);
		const markdown = conversationToMarkdown([], meta);
		expect(markdown).toContain("turns: 0");
		expect(markdown).not.toContain("## You");
	});

	test("writes frontmatter, a title and separated user and assistant sections", () => {
		const messages: ChatMessage[] = [
			{ role: "user", text: "What changed?", sourcePath: "Projects/Plan.md" },
			{ role: "assistant", text: "## Summary\n\n- Costs fell\n\n```ts\nconst a = 1;\n```", model: "gpt-5.5-mini" }
		];
		const markdown = conversationToMarkdown(messages, { ...meta, exportedAtLabel: "11 October 2026, 13:00" });
		expect(markdown.startsWith("---\ntitle: \"Budget review\"\nexported: 2026-10-11T12:00:00.000Z\n")).toBe(true);
		expect(markdown).toContain("provider: \"OpenAI\"");
		expect(markdown).toContain("turns: 2");
		expect(markdown).toContain("# Budget review");
		expect(markdown).toContain("Exported 11 October 2026, 13:00 · OpenAI, gpt-5.5");
		expect(markdown).toContain("## You\n\nWhat changed?\n\nSource note: [[Projects/Plan]]");
		expect(markdown).toContain("## AskMate (gpt-5.5-mini)\n\n## Summary\n\n- Costs fell\n\n```ts\nconst a = 1;\n```");
		expect(markdown.indexOf("## You")).toBeLessThan(markdown.indexOf("## AskMate"));
		expect(markdown.endsWith("\n")).toBe(true);
	});

	test("omits system and error lines", () => {
		const markdown = conversationToMarkdown(
			[{ role: "user", text: "Hi" }, { role: "system", text: "Provider failed with 500" }, { role: "assistant", text: "Hello" }],
			meta
		);
		expect(markdown).not.toContain("Provider failed");
		expect(markdown).toContain("turns: 2");
	});

	test("marks incomplete replies", () => {
		const markdown = conversationToMarkdown([{ role: "assistant", text: "Half an ans", incomplete: true }], meta);
		expect(markdown).toContain("> [!warning] Incomplete reply");
	});

	test("embeds a saved image and uses a placeholder otherwise", () => {
		const saved = conversationToMarkdown([{ role: "assistant", text: "Generated image with gpt-image-2.", image: true, imagePath: "AskMate/Images/lighthouse.png" }], meta);
		expect(saved).toContain("![[AskMate/Images/lighthouse.png]]");
		const unsaved = conversationToMarkdown([{ role: "assistant", text: "Generated image with gpt-image-2.", image: true }], meta);
		expect(unsaved).not.toContain("![[");
		expect(unsaved).toContain("not saved to the vault");
	});

	test("does not link a source path that would break the wikilink", () => {
		const markdown = conversationToMarkdown([{ role: "user", text: "Q", sourcePath: "Odd]]Name.md" }], meta);
		expect(markdown).not.toContain("Source note");
	});

	test("keeps special characters in titles valid in frontmatter and heading", () => {
		const markdown = conversationToMarkdown([{ role: "user", text: "Q" }], { ...meta, title: "Plan: \"Q3\" #1\nsecond line" });
		expect(markdown).toContain("title: \"Plan: \\\"Q3\\\" #1 second line\"");
		expect(markdown).toContain("# Plan: \"Q3\" #1 second line");
	});
});

describe("resolveExportTitle", () => {
	test("prefers the requested title, then the first question, then a default", () => {
		const messages: ChatMessage[] = [{ role: "user", text: "Summarise the roadmap\nwith dates" }];
		expect(resolveExportTitle("  My title ", messages)).toBe("My title");
		expect(resolveExportTitle("", messages)).toBe("Summarise the roadmap");
		expect(resolveExportTitle("", [])).toBe("AskMate conversation");
	});
});

describe("closeOpenFence", () => {
	test("closes an unclosed fence with the same marker and length", () => {
		expect(closeOpenFence("Intro\n````ts\nconst a = 1;")).toBe("Intro\n````ts\nconst a = 1;\n````");
		expect(closeOpenFence("~~~\nraw")).toBe("~~~\nraw\n~~~");
	});

	test("leaves balanced fences and inline backticks alone", () => {
		expect(closeOpenFence("```ts\nconst a = 1;\n```\ntext")).toBe("```ts\nconst a = 1;\n```\ntext");
		expect(closeOpenFence("Use ``` inline")).toBe("Use ``` inline");
		expect(closeOpenFence("````\n```\nstill code\n````")).toBe("````\n```\nstill code\n````");
	});

	test("an unclosed fence in a reply does not swallow the next exported turn", () => {
		const markdown = conversationToMarkdown(
			[
				{ role: "assistant", text: "```python\nprint(1)" },
				{ role: "user", text: "Next question" }
			],
			meta
		);
		expect(markdown).toContain("print(1)\n```\n\n---\n\n## You");
	});
});
