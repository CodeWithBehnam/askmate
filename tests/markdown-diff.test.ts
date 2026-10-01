import { describe, expect, test } from "bun:test";
import { buildMarkdownLineDiff, getMarkdownDiffStats } from "../src/shared/markdownDiff";

function lines(count: number, prefix = "line"): string[] {
	return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
}

describe("buildMarkdownLineDiff", () => {
	test("small notes show every line", () => {
		const rows = buildMarkdownLineDiff("a\nb\nc", "a\nB\nc");
		expect(rows).toHaveLength(4);
		expect(rows.filter((row) => row.kind === "removed").map((row) => row.text)).toEqual(["b"]);
		expect(rows.filter((row) => row.kind === "added").map((row) => row.text)).toEqual(["B"]);
		expect(rows.filter((row) => row.kind === "context")).toHaveLength(2);
	});

	test("an identical note reports no changes, and a line-ending-only change says so", () => {
		expect(buildMarkdownLineDiff("same\ntext", "same\ntext")).toEqual([
			{ kind: "omitted", oldLineNumber: null, newLineNumber: null, text: "No changes." }
		]);
		expect(buildMarkdownLineDiff("same\r\ntext", "same\ntext")[0].text).toContain("Only line endings change");
	});

	test("a one-line change in a 20,000-line note renders a handful of rows", () => {
		const before = lines(20000);
		const after = [...before];
		after[10] = "edited";
		const rows = buildMarkdownLineDiff(before.join("\n"), after.join("\n"));
		expect(rows.length).toBeLessThan(12);
		expect(rows.filter((row) => row.kind === "omitted").map((row) => row.text)).toEqual(["7 unchanged lines hidden", "19,986 unchanged lines hidden"]);
		expect(rows.find((row) => row.kind === "removed")).toEqual({ kind: "removed", oldLineNumber: 11, newLineNumber: null, text: "line 11" });
		expect(rows.find((row) => row.kind === "added")).toEqual({ kind: "added", oldLineNumber: null, newLineNumber: 11, text: "edited" });
	});

	test("trailing context keeps correct line numbers on both sides", () => {
		const before = lines(500);
		const after = ["new first line", ...before];
		const rows = buildMarkdownLineDiff(before.join("\n"), after.join("\n"));
		const firstContext = rows.find((row) => row.kind === "context");
		expect(firstContext).toEqual({ kind: "context", oldLineNumber: 1, newLineNumber: 2, text: "line 1" });
	});

	test("a full rewrite of a large note announces every hidden change", () => {
		const before = lines(1000, "old");
		const after = lines(1000, "new");
		const rows = buildMarkdownLineDiff(before.join("\n"), after.join("\n"));
		expect(rows.filter((row) => row.kind === "removed")).toHaveLength(200);
		expect(rows.filter((row) => row.kind === "added")).toHaveLength(200);
		expect(rows.filter((row) => row.kind === "omitted").map((row) => row.text)).toEqual([
			"800 more removed lines not shown. Apply writes every change.",
			"800 more added lines not shown. Apply writes every change."
		]);
	});

	test("changes in a large note are still diffed precisely when the changed region is small", () => {
		const before = lines(2000);
		const after = [...before.slice(0, 1000), "inserted", ...before.slice(1000)];
		const rows = buildMarkdownLineDiff(before.join("\n"), after.join("\n"));
		expect(rows.filter((row) => row.kind === "removed")).toHaveLength(0);
		expect(rows.filter((row) => row.kind === "added").map((row) => row.text)).toEqual(["inserted"]);
	});
});

describe("getMarkdownDiffStats", () => {
	test("counts every changed line, including ones the preview hides", () => {
		expect(getMarkdownDiffStats(lines(1000, "old").join("\n"), lines(1000, "new").join("\n"))).toEqual({ added: 1000, removed: 1000 });
		expect(getMarkdownDiffStats("a\nb", "a\nb\nc")).toEqual({ added: 1, removed: 0 });
	});
});
