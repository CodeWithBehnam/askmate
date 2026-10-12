import { describe, expect, test } from "bun:test";
import {
	buildUniquePathCandidate,
	getParentPath,
	hasPathIgnoringCase,
	sanitizeFileName,
	sanitizePathTemplateValue,
	sanitizePathTemplateValues
} from "../src/output/paths";

describe("sanitizeFileName", () => {
	test("strips leading dots so result notes are never hidden files", () => {
		expect(sanitizeFileName(".env review")).toBe("env review");
		expect(sanitizeFileName("...")).toBe("AskMate Response");
		expect(sanitizeFileName("..")).toBe("AskMate Response");
	});

	test("removes path separators, link syntax and control characters", () => {
		expect(sanitizeFileName("a/b\\c:d*e?f\"g<h>i|j#k^l[m]n")).toBe("abcdefghijklmn");
		expect(sanitizeFileName("line\none\ttwo")).toBe("line one two");
		expect(sanitizeFileName("del\u007fnel\u0085end")).toBe("del nel end");
	});

	test("drops trailing dots and spaces that Windows rejects", () => {
		expect(sanitizeFileName("Summary. . ")).toBe("Summary");
	});

	test("limits length by code point and never splits an emoji", () => {
		const name = `${"a".repeat(79)}😀😀`;
		const result = sanitizeFileName(name);
		expect(Array.from(result)).toHaveLength(80);
		expect(result.endsWith("😀")).toBe(true);
		expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(result)).toBe(false);
	});

	test("uses the fallback for empty names", () => {
		expect(sanitizeFileName("   ")).toBe("AskMate Response");
		expect(sanitizeFileName("", "Image")).toBe("Image");
	});

	test("removes zero-width, bidi and other format characters", () => {
		expect(sanitizeFileName("report\u202Efdp")).toBe("reportfdp");
		expect(sanitizeFileName("a\u200Bb\u200Dc\u2060d\uFEFFe\u00ADf")).toBe("abcdef");
		expect(sanitizeFileName("tag\u{E0041}\u{E0042}s")).toBe("tags");
		expect(sanitizeFileName("\u202E\u200B\u2066")).toBe("AskMate Response");
		expect(sanitizeFileName("mixed \u2067text\u2069 here")).toBe("mixed text here");
	});

	test("keeps scripts and emoji sequences that are not control characters", () => {
		expect(sanitizeFileName("\u0645\u0631\u0648\u0631 \u0631\u0648\u0632\u0627\u0646\u0647")).toBe("\u0645\u0631\u0648\u0631 \u0631\u0648\u0632\u0627\u0646\u0647");
		expect(sanitizeFileName("\u6587\u4EF6\u540D")).toBe("\u6587\u4EF6\u540D");
	});
});

describe("file name byte limits", () => {
	const encoder = new TextEncoder();
	const bytes = (text: string): number => encoder.encode(text).length;
	const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

	test.each([
		["80 CJK characters", "\u6F22".repeat(80)],
		["80 emoji", "\u{1F600}".repeat(80)],
		["a long mixed title", `${"\u6F22\u{1F600}a".repeat(40)}`],
		["80 accented letters", "\u00E9".repeat(80)]
	])("a title of %s still makes a file name under 255 bytes with a stamp, an attempt number and an extension", (_name: string, title: string) => {
		const base = sanitizeFileName(title);
		expect(bytes(base)).toBeLessThanOrEqual(200);
		expect(Array.from(base).length).toBeLessThanOrEqual(80);
		const candidate = buildUniquePathCandidate("AskMate/Results", base, "2026-10-12 1200", "md", 12);
		expect(bytes(lastSegment(candidate))).toBeLessThanOrEqual(255);
		expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(base)).toBe(false);
	});

	test("short names and the 80 code point cap are unchanged", () => {
		expect(sanitizeFileName("Plan for Q3")).toBe("Plan for Q3");
		expect(Array.from(sanitizeFileName("a".repeat(120)))).toHaveLength(80);
	});

	test("a byte budget can be given, and trailing dots left by the cut are dropped", () => {
		expect(sanitizeFileName("abc.....def", "x", 80, 7)).toBe("abc");
		expect(bytes(sanitizeFileName("\u6F22\u6F22\u6F22\u6F22", "x", 80, 7))).toBeLessThanOrEqual(7);
	});
});

describe("sanitizePathTemplateValue", () => {
	test("cannot add folder levels or dot segments", () => {
		expect(sanitizePathTemplateValue("../../outside")).toBe("outside");
		expect(sanitizePathTemplateValue("a cat / on a mat")).toBe("a cat on a mat");
		expect(sanitizePathTemplateValue("..")).toBe("");
	});

	test("sanitises only the named keys", () => {
		const result = sanitizePathTemplateValues({ imagePrompt: "../x", sourcePath: "Notes/Daily" }, ["imagePrompt"]);
		expect(result).toEqual({ imagePrompt: "x", sourcePath: "Notes/Daily" });
	});
});

describe("unique path helpers", () => {
	test("builds the first candidate without a suffix and later ones with the attempt number", () => {
		expect(buildUniquePathCandidate("AskMate", "Note", "2026-10-01 1200", "md", 1)).toBe("AskMate/Note 2026-10-01 1200.md");
		expect(buildUniquePathCandidate("AskMate", "Note", "2026-10-01 1200", ".md", 3)).toBe("AskMate/Note 2026-10-01 1200 3.md");
		expect(buildUniquePathCandidate("", "Note", "stamp", "png", 1)).toBe("Note stamp.png");
	});

	test("treats paths that differ only in case as the same file", () => {
		expect(hasPathIgnoringCase("AskMate/Note.md", ["askmate/note.md"])).toBe(true);
		expect(hasPathIgnoringCase("AskMate/Note.md", ["AskMate/Other.md"])).toBe(false);
	});

	test("returns the parent folder path", () => {
		expect(getParentPath("a/b/c.md")).toBe("a/b");
		expect(getParentPath("c.md")).toBe("");
	});
});
