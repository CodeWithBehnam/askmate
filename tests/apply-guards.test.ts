import { describe, expect, test } from "bun:test";
import { chooseSmartResultFolder, getReplaceBlockReason, isOriginalSelectionNote, planImageInsertion } from "../src/output/applyGuards";

const EMBED = "![[img.png]]";

function insert(text: string, cursor: number): string {
	const plan = planImageInsertion(text, cursor, EMBED);
	return `${text.slice(0, plan.offset)}${plan.text}${text.slice(plan.offset)}`;
}

describe("getReplaceBlockReason", () => {
	test("blocks replacing when the note context was not sent", () => {
		expect(getReplaceBlockReason({ includeNoteContext: false, includeImageReferences: true }, "text")).toContain("did not see");
	});

	test("blocks replacing text with images when image references were hidden", () => {
		expect(getReplaceBlockReason({ includeNoteContext: true, includeImageReferences: false }, "see ![[a.png]]")).toContain("images");
		expect(getReplaceBlockReason({ includeNoteContext: true, includeImageReferences: false }, "plain text")).toBeNull();
	});

	test("allows replacing under default privacy", () => {
		expect(getReplaceBlockReason({ includeNoteContext: true, includeImageReferences: true }, "see ![[a.png]]")).toBeNull();
	});
});

describe("isOriginalSelectionNote", () => {
	test("accepts a renamed file when it is the same object", () => {
		const file = { path: "New.md" };
		expect(isOriginalSelectionNote("Old.md", file, file)).toBe(true);
	});

	test("rejects a different file with a different path", () => {
		expect(isOriginalSelectionNote("Old.md", { path: "Other.md" }, { path: "Old.md" })).toBe(false);
		expect(isOriginalSelectionNote("Old.md", null, null)).toBe(false);
	});

	test("accepts a matching path without a request file", () => {
		expect(isOriginalSelectionNote("A.md", { path: "A.md" }, null)).toBe(true);
	});
});

describe("planImageInsertion", () => {
	test("a mid-sentence cursor inserts after the paragraph", () => {
		const text = "First sentence here. Second one.\n\nNext paragraph.";
		expect(insert(text, 8)).toBe(`First sentence here. Second one.\n\n${EMBED}\n\nNext paragraph.`);
	});

	test("a cursor at the very start does not go above frontmatter", () => {
		const text = "---\ntitle: x\n---\nBody line.\n";
		expect(insert(text, 0)).toBe(`---\ntitle: x\n---\n\n${EMBED}\n\nBody line.\n`);
	});

	test("a cursor inside frontmatter moves after it", () => {
		const text = "---\ntitle: x\n---\n\nBody.";
		const result = insert(text, 6);
		expect(result.indexOf(EMBED)).toBeGreaterThan(result.indexOf("---\n\n"));
	});

	test("a cursor inside a code fence moves after the closing fence", () => {
		const text = "Intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nOutro";
		expect(insert(text, text.indexOf("const b"))).toBe(`Intro\n\n\`\`\`ts\nconst a = 1;\nconst b = 2;\n\`\`\`\n\n${EMBED}\n\nOutro`);
	});

	test("a cursor inside a table moves after the table", () => {
		const text = "| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter";
		expect(insert(text, 14)).toBe(`| a | b |\n| - | - |\n| 1 | 2 |\n\n${EMBED}\n\nAfter`);
	});

	test("a cursor at the end of the note appends with a blank line", () => {
		expect(insert("Only line", 9)).toBe(`Only line\n\n${EMBED}\n`);
	});

	test("a cursor on a blank line between paragraphs inserts there", () => {
		const text = "One\n\nTwo";
		expect(insert(text, 4)).toBe(`One\n\n${EMBED}\n\nTwo`);
	});

	test("an unclosed fence goes to the end of the note", () => {
		const text = "Intro\n\n```\ncode";
		expect(insert(text, text.indexOf("code"))).toBe(`Intro\n\n\`\`\`\ncode\n\n${EMBED}\n`);
	});
});

describe("planImageInsertion: fences and line endings", () => {
	test("an inline triple-backtick line is not a fence", () => {
		const text = "First paragraph.\n\n```inline``` is how you mark a span.\n\nSecond paragraph.\n\nThird paragraph.";
		expect(insert(text, text.indexOf("Second"))).toBe(`First paragraph.\n\n\`\`\`inline\`\`\` is how you mark a span.\n\nSecond paragraph.\n\n${EMBED}\n\nThird paragraph.`);
	});

	test("a cursor inside a tab-indented list fence with a blank line moves after the closing fence", () => {
		const text = "- item\n\t```mermaid\n\tgraph TD\n\n\t  A-->B\n\t```\n\nAfter";
		const result = insert(text, text.indexOf("A-->B"));
		expect(result).toBe(`- item\n\t\`\`\`mermaid\n\tgraph TD\n\n\t  A-->B\n\t\`\`\`\n\n${EMBED}\n\nAfter`);
		expect(result.indexOf(EMBED)).toBeGreaterThan(result.lastIndexOf("```"));
	});

	test("a four-space list fence and a quoted fence are handled the same way", () => {
		const four = "- item\n    ```mermaid\n    graph TD\n\n    A-->B\n    ```\n\nAfter";
		expect(insert(four, four.indexOf("A-->B"))).toBe(`- item\n    \`\`\`mermaid\n    graph TD\n\n    A-->B\n    \`\`\`\n\n${EMBED}\n\nAfter`);
		const quoted = "> ```js\n> a\n>\n> b\n> ```\n\nAfter";
		expect(insert(quoted, quoted.indexOf("> b") + 2)).toBe(`> \`\`\`js\n> a\n>\n> b\n> \`\`\`\n\n${EMBED}\n\nAfter`);
	});

	test("a CRLF note gets CRLF separators and its line-ending pairs stay whole", () => {
		const text = "One\r\n\r\nTwo\r\n\r\nThree";
		expect(insert(text, 0)).toBe(`One\r\n\r\n${EMBED}\r\n\r\nTwo\r\n\r\nThree`);
		const fenced = "Intro\r\n\r\n```ts\r\nlet a;\r\n```\r\n\r\nOutro";
		expect(insert(fenced, fenced.indexOf("let"))).toBe(`Intro\r\n\r\n\`\`\`ts\r\nlet a;\r\n\`\`\`\r\n\r\n${EMBED}\r\n\r\nOutro`);
		expect(insert("Only line\r\n", 9)).toBe(`Only line\r\n\r\n${EMBED}\r\n`);
	});

	test("an insertion at the selection end or the note end stays out of a fence, and says when it cannot", () => {
		const closed = "Para one is here. Para two.\n\n```js\ncode\n```\n";
		expect(insert(closed, closed.indexOf("Para two") + 8)).toBe(`Para one is here. Para two.\n\n${EMBED}\n\n\`\`\`js\ncode\n\`\`\`\n`);
		const open = "Intro\n\n```\ncode";
		const plan = planImageInsertion(open, open.length, EMBED);
		expect(plan.insideOpenFence).toBe(true);
		expect(planImageInsertion(closed, 0, EMBED).insideOpenFence).toBeUndefined();
	});
});

describe("chooseSmartResultFolder", () => {
	test("adds the AskMate folder under a normal parent", () => {
		expect(chooseSmartResultFolder("Projects")).toBe("Projects/AskMate");
		expect(chooseSmartResultFolder("/")).toBe("AskMate");
	});

	test("reuses a parent that already is the AskMate folder", () => {
		expect(chooseSmartResultFolder("Projects/AskMate")).toBe("Projects/AskMate");
		expect(chooseSmartResultFolder("AskMate")).toBe("AskMate");
	});

	test("does not treat a folder that merely ends in the name as the result folder", () => {
		expect(chooseSmartResultFolder("Projects/MyAskMate")).toBe("Projects/MyAskMate/AskMate");
	});
});
