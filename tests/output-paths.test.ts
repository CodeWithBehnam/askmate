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
