import { describe, expect, test } from "bun:test";
import {
	IMAGE_REFERENCE_OMITTED,
	PROMPT_DELIMITER_TAGS,
	escapePromptAttribute,
	escapePromptDelimiters,
	stripImageReferences
} from "../src/requests/promptSafety";

const OMITTED = IMAGE_REFERENCE_OMITTED;

function elapsed(action: () => void): number {
	const started = performance.now();
	action();
	return performance.now() - started;
}

describe("PROMPT_DELIMITER_TAGS", () => {
	test("covers the prompt sections, skills and tool output", () => {
		for (const tag of ["note_context", "context_attachment", "evidence_sources", "user_request", "image_request", "skill", "skill_context", "active_skills", "tool_result", "tool_definitions"]) {
			expect(PROMPT_DELIMITER_TAGS as readonly string[]).toContain(tag);
		}
	});
});

describe("escapePromptDelimiters", () => {
	test("neutralises the new skill and tool tags in every spelling", () => {
		for (const tag of ["skill", "skill_context", "active_skills", "tool_result", "tool_definitions"]) {
			for (const variant of [`<${tag}>`, `</${tag}>`, `< /${tag.toUpperCase()} >`, `<${tag} name="x" source="vault">`]) {
				const escaped = escapePromptDelimiters(variant);
				expect({ variant, escaped: escaped.startsWith("&lt;") }).toEqual({ variant, escaped: true });
			}
		}
		expect(escapePromptDelimiters("<tool_result server=\"a\" tool=\"b\" status=\"ok\" trust=\"untrusted\">")).toBe("&lt;tool_result server=\"a\" tool=\"b\" status=\"ok\" trust=\"untrusted\">");
	});

	test("neutralises tags with zero-width, word-joiner, soft-hyphen and other format characters", () => {
		const format = ["\u200B", "\u200C", "\u200D", "\u2060", "\u00AD", "\uFEFF", "\u202E", "\u2066", "\u200E", "\u061C"];
		for (const char of format) {
			for (const variant of [
				`<${char}/note_context>`, `</${char}note_context>`, `<${char}user_request>`, `<${char}/${char}skill>`,
				`<${char}${char}tool_result>`, `< ${char} / ${char} active_skills>`, `<note${char}_context>`, `<user_${char}request>`
			]) {
				const escaped = escapePromptDelimiters(variant);
				expect({ variant, escaped: escaped.startsWith("&lt;") }).toEqual({ variant, escaped: true });
			}
		}
	});

	test("keeps every original character after the escaped bracket", () => {
		expect(escapePromptDelimiters("<\u200B/note_context>")).toBe("&lt;\u200B/note_context>");
		expect(escapePromptDelimiters("</\u00ADuser_request attr>")).toBe("&lt;/\u00ADuser_request attr>");
	});

	test("leaves ordinary angle brackets and look-alike names alone", () => {
		const text = "a < b, <div>html</div>, <notes>, <user>, <tool>, <ski>, a<\u200Bb and 5 < 6";
		expect(escapePromptDelimiters(text)).toBe(text);
	});

	test("stays linear on long runs of spaces and format characters", () => {
		const inputs = [
			`<${" ".repeat(200000)}x`,
			"< ".repeat(100000),
			"<\u200B".repeat(100000),
			`${"<".repeat(100000)}note_contex`,
			`<${"\u200B".repeat(100000)}note_contex`,
			`< /${" ".repeat(100000)}n`,
			"<n\u200Bo\u200Bt\u200Be\u200B_\u200Bc\u200Bo\u200Bn\u200Bt\u200Be\u200Bx ".repeat(10000)
		];
		for (const input of inputs) {
			expect(elapsed(() => escapePromptDelimiters(input))).toBeLessThan(200);
		}
	});
});

describe("escapePromptAttribute", () => {
	test("keeps a value on one line inside double quotes", () => {
		expect(escapePromptAttribute("a\n\"b\"\t<c>")).toBe("a 'b' &lt;c&gt;");
	});
});

describe("stripImageReferences: destinations the old pattern missed", () => {
	test("strips markdown images whose paths contain parentheses", () => {
		for (const text of [
			"![alt](images/Client Acme (confidential).png)",
			"![alt](<my photo (1).png>)",
			"![](Screenshot%202026-10-12%20(1).png)",
			"![](Screenshot 2026-10-12 (1).png)",
			"![alt](dir/shot (1).png \"title\")",
			"![alt](a(b(c)).png)",
			"[plain link to an image](shots/one (2).jpg)"
		]) {
			expect({ text, stripped: stripImageReferences(text) }).toEqual({ text, stripped: OMITTED });
		}
	});

	test("strips data:image URIs of any size, as images or definitions", () => {
		const payload = "iVBORw0KGgo".repeat(20000);
		expect(stripImageReferences(`![](data:image/png;base64,${payload})`)).toBe(OMITTED);
		expect(stripImageReferences(`Before ![x](DATA:IMAGE/SVG+XML;base64,${payload}) after`)).toBe(`Before ${OMITTED} after`);
		expect(stripImageReferences(`[pic]: data:image/png;base64,${payload}`)).toBe(OMITTED);
		expect(stripImageReferences(`<img src="data:image/png;base64,${payload}">`)).toBe(OMITTED);
	});

	test("strips picture sources, srcset and svg images", () => {
		expect(stripImageReferences("<picture><source srcset=\"secret.webp\"></picture>")).toBe(`<picture>${OMITTED}</picture>`);
		expect(stripImageReferences("<picture><source srcset=\"a.avif 1x, b.avif 2x\" type=\"image/avif\"><img src=\"c.png\"></picture>")).toBe(`<picture>${OMITTED}${OMITTED}</picture>`);
		expect(stripImageReferences("<svg><image href=\"secret.png\"/></svg>")).toBe(`<svg>${OMITTED}</svg>`);
		expect(stripImageReferences("<svg><image xlink:href='secret.png' /></svg>")).toBe(`<svg>${OMITTED}</svg>`);
		expect(stripImageReferences("<source src=\"data:image/gif;base64,R0lGOD\">")).toBe(OMITTED);
	});

	test("treats a quoted > inside an img tag as part of the tag", () => {
		expect(stripImageReferences("<img alt=\"a>b\" src=\"secret.png\">")).toBe(OMITTED);
		expect(stripImageReferences("x <IMG ALT='a>b' SRC='s.png'/> y")).toBe(`x ${OMITTED} y`);
	});

	test("leaves non-image sources, plain links and other tags alone", () => {
		const text = [
			"<video><source src=\"clip.mp4\" type=\"video/mp4\"></video>",
			"<audio><source src=\"clip.mp3\"></audio>",
			"[docs](https://example.com/page) and [note](Note.md) and [a (b)](folder/file (1).md)",
			"[[Ordinary note]] and [[Another|alias]]",
			"<svg><circle r=\"3\"/><image-map></image-map></svg>",
			"<span>image.png is mentioned in text</span>",
			"![alt](https://example.com/page)"
		].join("\n");
		expect(stripImageReferences(text)).toBe(text);
	});

	test("keeps the behaviour the privacy tests already pin", () => {
		const text = [
			"![[secret-photo.png]]",
			"![d](<my diagram.png>)",
			"![t](pic.jpg \"Title\")",
			"[logo]: assets/logo.webp",
			"<img src=\"scan.jpeg\">",
			"[[Ordinary note]] and [link](https://example.com/page)"
		].join("\n");
		expect(stripImageReferences(text)).toBe([OMITTED, OMITTED, OMITTED, OMITTED, OMITTED, "[[Ordinary note]] and [link](https://example.com/page)"].join("\n"));
	});

	test("strips bare image lines only on request", () => {
		const text = "Label\n  folder/private scan.png  \nOther";
		expect(stripImageReferences(text)).toBe(text);
		expect(stripImageReferences(text, { bareLines: true })).toBe(`Label\n${OMITTED}\nOther`);
		expect(stripImageReferences("a.png b", { bareLines: true })).toBe("a.png b");
	});

	test("handles unbalanced and unterminated constructs without hanging or dropping text", () => {
		for (const text of ["![alt](unclosed.png", "![alt](<unclosed.png", "![alt]", "[[unclosed.png", "<img src=\"x.png", "![alt](a.png \"unterminated title)"]) {
			expect(typeof stripImageReferences(text)).toBe("string");
		}
		expect(stripImageReferences("keep ![alt](unclosed.png and more")).toContain("and more");
		expect(stripImageReferences("![a](b.png)![c](d.png)")).toBe(`${OMITTED}${OMITTED}`);
	});
});

describe("stripImageReferences: linear time", () => {
	test("crafted input does not freeze the editor", () => {
		const inputs = [
			"[[".repeat(50000),
			"![](".repeat(40000),
			"![a](<".repeat(30000),
			"<img \"".repeat(30000),
			"<img ".repeat(30000),
			"<source ".repeat(20000),
			`${"[a]: ".repeat(20000)}`,
			Array.from({ length: 20000 }, () => "[").join("\n"),
			"![".repeat(50000) + "]".repeat(50000),
			`x${" ".repeat(150000)}y`,
			"![a](b(".repeat(20000)
		];
		for (const input of inputs) {
			expect(elapsed(() => stripImageReferences(input))).toBeLessThan(400);
			expect(elapsed(() => stripImageReferences(input, { bareLines: true }))).toBeLessThan(400);
		}
	});
});
