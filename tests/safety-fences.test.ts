import { describe, expect, test } from "bun:test";
import { planImageInsertion } from "../src/output/applyGuards";
import { closeOpenFence as closeOpenFenceFromExport } from "../src/output/conversationExport";
import {
	closeOpenFence,
	endsInsideOpenFence,
	fenceLineFlags,
	planBlockInsertion,
	scanFences
} from "../src/safety/markdownFences";
import { planRangeEdit } from "../src/safety/rangeEdit";

const lines = (text: string): string[] => text.split(/\r?\n/);

function insert(text: string, cursor: number, block = "![[img.png]]"): string {
	const plan = planBlockInsertion(text, cursor, block);
	return `${text.slice(0, plan.offset)}${plan.text}${text.slice(plan.offset)}`;
}

describe("scanFences", () => {
	test("finds closed and unclosed top-level fences", () => {
		const spans = scanFences(lines("a\n```ts\nx\n```\nb\n~~~\ny"));
		expect(spans.map((span) => [span.openLine, span.closeLine, span.endLine, span.open])).toEqual([[1, 3, 3, false], [5, null, 6, true]]);
		expect(spans[0]).toMatchObject({ marker: "`", length: 3, language: "ts", quoteDepth: 0 });
	});

	test("a longer or different marker does not close a fence", () => {
		const spans = scanFences(lines("````\n```\nstill code\n~~~\n````\nafter"));
		expect(spans).toHaveLength(1);
		expect(spans[0]).toMatchObject({ openLine: 0, closeLine: 4, length: 4 });
		expect(scanFences(lines("```\ncode\n````"))[0].closeLine).toBe(2);
	});

	test("a closing fence cannot carry an info string", () => {
		const spans = scanFences(lines("```\ncode\n```js\nmore\n```"));
		expect(spans[0].closeLine).toBe(4);
	});

	test("a backtick line with backticks in the info string is inline code, not a fence", () => {
		expect(scanFences(lines("```inline``` is how you mark a span.\n\ntext"))).toEqual([]);
		expect(scanFences(lines("~~~inline``` is fine as a tilde fence\nx"))).toHaveLength(1);
	});

	test("an opener may be indented by up to three spaces, but four is an indented code block", () => {
		expect(scanFences(lines("   ```js\n   x\n   ```"))).toHaveLength(1);
		expect(scanFences(lines("    ```js\n    x\n    ```"))).toEqual([]);
	});

	test("fences inside a list item may be indented by tabs or any width beyond the list content", () => {
		const tab = scanFences(lines("- item\n\t```mermaid\n\t%% c\n\tgraph TD\n\n\t  A-->B\n\t```\n\n# B"));
		expect(tab).toHaveLength(1);
		expect(tab[0]).toMatchObject({ openLine: 1, closeLine: 6, language: "mermaid" });
		const four = scanFences(lines("- item\n    ```mermaid\n    graph TD\n\n    A-->B\n    ```\n\nafter"));
		expect(four[0]).toMatchObject({ openLine: 1, closeLine: 5 });
		const nested = scanFences(lines("- a\n  - b\n    ```js\n    x\n    ```"));
		expect(nested[0]).toMatchObject({ openLine: 2, closeLine: 4 });
		const onMarkerLine = scanFences(lines("- ```js\n  x\n  ```"));
		expect(onMarkerLine[0]).toMatchObject({ openLine: 0, closeLine: 2 });
	});

	test("an over-indented line inside a list item is code, not a fence", () => {
		expect(scanFences(lines("- item\n\n          ```js\n          x\n          ```"))).toEqual([]);
	});

	test("fences inside a block quote are matched on their quoted lines", () => {
		const spans = scanFences(lines("> ```js\n> a\n>\n> b\n> ```\n\nafter"));
		expect(spans[0]).toMatchObject({ openLine: 0, closeLine: 4, quoteDepth: 1 });
		const callout = scanFences(lines("> [!note]\n> ```mermaid\n> graph TD\n> ```"));
		expect(callout[0]).toMatchObject({ openLine: 1, closeLine: 3 });
	});

	test("a quoted fence ends where the quote ends", () => {
		const spans = scanFences(lines("> ```js\n> a\nplain line\n```\nnext"));
		expect(spans[0]).toMatchObject({ openLine: 0, closeLine: null, endLine: 1, open: false });
		expect(spans[1]).toMatchObject({ openLine: 3, open: true });
	});

	test("a list fence ends where the list item ends", () => {
		const spans = scanFences(lines("- item\n  ```js\n  a\nnot indented\nmore"));
		expect(spans[0]).toMatchObject({ openLine: 1, closeLine: null, endLine: 2, open: false });
	});

	test("starts after the lines to skip, such as frontmatter", () => {
		expect(scanFences(lines("---\n```\n---\ntext"), { from: 3 })).toEqual([]);
	});
});

describe("fenceLineFlags", () => {
	test("marks every line from the opener to the closer", () => {
		expect(fenceLineFlags(lines("a\n```\nb\n```\nc"))).toEqual([false, true, true, true, false]);
		expect(fenceLineFlags(lines("a\n```\nb"))).toEqual([false, true, true]);
	});
});

describe("endsInsideOpenFence", () => {
	test("is true only while a fence is open at the end of the text", () => {
		expect(endsInsideOpenFence("# Note\n\n```mermaid\ngraph TD\n A-->B\n")).toBe(true);
		expect(endsInsideOpenFence("```js\nx\n```\n")).toBe(false);
		expect(endsInsideOpenFence("text only")).toBe(false);
		expect(endsInsideOpenFence("````\n```\nx\n````")).toBe(false);
		expect(endsInsideOpenFence("```inline``` text")).toBe(false);
		expect(endsInsideOpenFence("- a\n\t```js\n\tx\n")).toBe(true);
		expect(endsInsideOpenFence("- a\n\t```js\n\tx\nplain")).toBe(false);
		expect(endsInsideOpenFence("```js\r\nx\r\n")).toBe(true);
		expect(endsInsideOpenFence("")).toBe(false);
	});
});

describe("endsInsideOpenFence: top-level only", () => {
	test("ignores a fence that sits in a quote or list item, which a blank line and a flush-left line end", () => {
		const options = { topLevelOnly: true };
		expect(endsInsideOpenFence("> ```js\n> x", options)).toBe(false);
		expect(endsInsideOpenFence("- a\n\t```js\n\tx\n", options)).toBe(false);
		expect(endsInsideOpenFence("   ```js\nx", options)).toBe(true);
		expect(endsInsideOpenFence("~~~\nx", options)).toBe(true);
		expect(endsInsideOpenFence("```js\nx\n```", options)).toBe(false);
	});
});

describe("closeOpenFence", () => {
	test("closes with the same marker and length, as the conversation export always did", () => {
		expect(closeOpenFence("Intro\n````ts\nconst a = 1;")).toBe("Intro\n````ts\nconst a = 1;\n````");
		expect(closeOpenFence("~~~\nraw")).toBe("~~~\nraw\n~~~");
		expect(closeOpenFence("```ts\nx\n```\ntext")).toBe("```ts\nx\n```\ntext");
		expect(closeOpenFenceFromExport).toBe(closeOpenFence);
	});

	test("closes quoted and list-nested fences inside their container", () => {
		expect(closeOpenFence("> ```js\n> x")).toBe("> ```js\n> x\n> ```");
		expect(closeOpenFence("> > ```js\n> > x")).toBe("> > ```js\n> > x\n> > ```");
		expect(closeOpenFence("- item\n  ```js\n  x")).toBe("- item\n  ```js\n  x\n  ```");
		expect(closeOpenFence("- ```js\n  x")).toBe("- ```js\n  x\n  ```");
	});

	test("keeps the line endings of the text", () => {
		expect(closeOpenFence("```js\r\nx")).toBe("```js\r\nx\r\n```");
	});
});

describe("planBlockInsertion", () => {
	test("matches the image planner for the cases the planner already handled", () => {
		const text = "First sentence here. Second one.\n\nNext paragraph.";
		expect(planBlockInsertion(text, 8, "X")).toEqual(planImageInsertion(text, 8, "X"));
		expect(insert(text, 8)).toBe("First sentence here. Second one.\n\n![[img.png]]\n\nNext paragraph.");
	});

	test("an inline triple-backtick line is not a fence", () => {
		const text = "First paragraph.\n\n```inline``` is how you mark a span.\n\nSecond paragraph.\n\nThird paragraph.";
		expect(insert(text, text.indexOf("Second"))).toBe("First paragraph.\n\n```inline``` is how you mark a span.\n\nSecond paragraph.\n\n![[img.png]]\n\nThird paragraph.");
	});

	test("a cursor inside a tab-indented list fence with blank lines moves after the closing fence", () => {
		const text = "- item\n\t```mermaid\n\tgraph TD\n\n\t  A-->B\n\t```\n\nAfter";
		expect(insert(text, text.indexOf("A-->B"))).toBe("- item\n\t```mermaid\n\tgraph TD\n\n\t  A-->B\n\t```\n\n![[img.png]]\n\nAfter");
	});

	test("a cursor inside a four-space list fence and a quoted fence moves after them", () => {
		const four = "- item\n    ```mermaid\n    graph TD\n\n    A-->B\n    ```\n\nAfter";
		expect(insert(four, four.indexOf("A-->B"))).toBe("- item\n    ```mermaid\n    graph TD\n\n    A-->B\n    ```\n\n![[img.png]]\n\nAfter");
		const quoted = "> ```js\n> a\n>\n> b\n> ```\n\nAfter";
		expect(insert(quoted, quoted.indexOf("> b") + 2)).toBe("> ```js\n> a\n>\n> b\n> ```\n\n![[img.png]]\n\nAfter");
	});

	test("the paragraph walk stops before a list-nested fence", () => {
		const text = "Para line one\nPara line two\n- item\n\t```js\n\tx\n\t```\n";
		const result = insert(text, 2);
		expect(result.indexOf("![[img.png]]")).toBeGreaterThan(result.indexOf("- item") - 1);
	});

	test("a CRLF note gets CRLF separators and an untouched CRLF pair", () => {
		const text = "One\r\n\r\nTwo\r\n\r\nThree";
		expect(insert(text, 0)).toBe("One\r\n\r\n![[img.png]]\r\n\r\nTwo\r\n\r\nThree");
		expect(insert("Only line", 9)).toBe("Only line\n\n![[img.png]]\n");
		expect(insert("Only line\r\n", 9)).toBe("Only line\r\n\r\n![[img.png]]\r\n");
		const fenced = "Intro\r\n\r\n```ts\r\nlet a;\r\n```\r\n\r\nOutro";
		expect(insert(fenced, fenced.indexOf("let"))).toBe("Intro\r\n\r\n```ts\r\nlet a;\r\n```\r\n\r\n![[img.png]]\r\n\r\nOutro");
	});

	test("an explicit line ending overrides the note's own", () => {
		expect(planBlockInsertion("Only line", 9, "X", { eol: "\r\n" })).toEqual({ offset: 9, text: "\r\n\r\nX\r\n" });
	});

	test("appends after a trailing unclosed fence rather than inside it", () => {
		const text = "Intro\n\n```\ncode";
		expect(insert(text, text.length)).toBe("Intro\n\n```\ncode\n\n![[img.png]]\n");
	});
});

describe("planRangeEdit", () => {
	test("finds the smallest single edit that turns one text into another", () => {
		expect(planRangeEdit("abcdef", "abXdef")).toEqual({ start: 2, end: 3, insert: "X" });
		expect(planRangeEdit("abc", "abc")).toEqual({ start: 3, end: 3, insert: "" });
		expect(planRangeEdit("abc", "abXc")).toEqual({ start: 2, end: 2, insert: "X" });
		expect(planRangeEdit("abXc", "abc")).toEqual({ start: 2, end: 3, insert: "" });
		expect(planRangeEdit("", "new")).toEqual({ start: 0, end: 0, insert: "new" });
		expect(planRangeEdit("old", "")).toEqual({ start: 0, end: 3, insert: "" });
	});

	test("does not let the prefix and the suffix overlap", () => {
		expect(planRangeEdit("aaa", "aaaa")).toEqual({ start: 3, end: 3, insert: "a" });
		expect(planRangeEdit("abab", "ab")).toEqual({ start: 2, end: 4, insert: "" });
	});

	test("never splits a surrogate pair", () => {
		const before = "a\u{1F600}b";
		const after = "a\u{1F601}b";
		const edit = planRangeEdit(before, after);
		expect(before.slice(0, edit.start) + edit.insert + before.slice(edit.end)).toBe(after);
		expect(edit).toEqual({ start: 1, end: 3, insert: "\u{1F601}" });
	});

	test("applying the edit always reproduces the new text", () => {
		const samples = ["", "a", "ab\ncd", "line\r\nnext", "\u{1F600}\u{1F601}", "x".repeat(100)];
		for (const before of samples) {
			for (const after of samples) {
				const edit = planRangeEdit(before, after);
				expect(before.slice(0, edit.start) + edit.insert + before.slice(edit.end)).toBe(after);
			}
		}
	});
});
