import { describe, expect, test } from "bun:test";
import { buildMarkdownLineDiff, describeMarkdownDiffSummary, getMarkdownDiffStats, summariseMarkdownDiff } from "../src/shared/markdownDiff";

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

describe("scattered edits in large notes", () => {
	function withEdits(count: number, edits: Record<number, string>): { before: string; after: string } {
		const before = lines(count);
		const after = before.map((text, index) => edits[index + 1] ?? text);
		return { before: before.join("\n"), after: after.join("\n") };
	}

	test.each([500, 5000])("two distant edits in a %i-line note are reported as two changes", (count: number) => {
		const { before, after } = withEdits(count, { 10: "EDITED TEN", [count - 10]: "EDITED NEAR THE END" });
		expect(getMarkdownDiffStats(before, after)).toEqual({ added: 2, removed: 2 });
		const rows = buildMarkdownLineDiff(before, after);
		expect(rows.filter((row) => row.kind === "added").map((row) => row.text)).toEqual(["EDITED TEN", "EDITED NEAR THE END"]);
		expect(rows.filter((row) => row.kind === "removed").map((row) => row.text)).toEqual(["line 10", `line ${count - 10}`]);
		expect(rows.filter((row) => row.kind === "omitted").every((row) => row.text.includes("unchanged"))).toBe(true);
	});

	test("many scattered edits are all shown with exact counts", () => {
		const edits: Record<number, string> = {};
		for (let line = 25; line <= 2000; line += 50) {
			edits[line] = `changed ${line}`;
		}
		const { before, after } = withEdits(2000, edits);
		expect(getMarkdownDiffStats(before, after)).toEqual({ added: 40, removed: 40 });
		const rows = buildMarkdownLineDiff(before, after);
		expect(rows.filter((row) => row.kind === "added")).toHaveLength(40);
		expect(rows.filter((row) => row.kind === "removed")).toHaveLength(40);
	});

	test("insertions and deletions far apart keep their line numbers", () => {
		const before = lines(1000);
		const after = [...before.slice(0, 100), "inserted near the top", ...before.slice(100, 900), ...before.slice(950)];
		const rows = buildMarkdownLineDiff(before.join("\n"), after.join("\n"));
		expect(rows.find((row) => row.kind === "added")).toEqual({ kind: "added", oldLineNumber: null, newLineNumber: 101, text: "inserted near the top" });
		expect(rows.filter((row) => row.kind === "removed")).toHaveLength(50);
		expect(rows.find((row) => row.kind === "removed")).toMatchObject({ oldLineNumber: 901, text: "line 901" });
		expect(getMarkdownDiffStats(before.join("\n"), after.join("\n"))).toEqual({ added: 1, removed: 50 });
	});

	test("a large reordered rewrite is still diffed line by line, not as one block", () => {
		const before = lines(3000);
		const after = [...before.slice(1500), ...before.slice(0, 1500)];
		const stats = getMarkdownDiffStats(before.join("\n"), after.join("\n"));
		expect(stats.added).toBeLessThan(3000);
		expect(stats.removed).toBeLessThan(3000);
	});

	test("big notes with big changes diff in well under a second", () => {
		const before = lines(8000);
		const after = before.map((text, index) => (index % 3 === 0 ? `rewritten ${index}` : text));
		const started = performance.now();
		const stats = getMarkdownDiffStats(before.join("\n"), after.join("\n"));
		buildMarkdownLineDiff(before.join("\n"), after.join("\n"));
		expect(performance.now() - started).toBeLessThan(1500);
		expect(stats.added).toBe(Math.ceil(8000 / 3));
		expect(stats.removed).toBe(Math.ceil(8000 / 3));
	});
});

describe("diff order, summaries and honesty", () => {
	test("a replaced line lists the removal before the addition", () => {
		const kinds = buildMarkdownLineDiff("a\nold\nz", "a\nnew\nz").map((row) => row.kind);
		expect(kinds).toEqual(["context", "removed", "added", "context"]);
		const block = buildMarkdownLineDiff("a\nb\nc\nd\ne\nf", "a\nB\nC\nd\nE\nf").map((row) => row.kind);
		expect(block).toEqual(["context", "removed", "removed", "added", "added", "context", "removed", "added", "context"]);
	});

	test("counts changed places, not just lines", () => {
		const before = lines(600).join("\n");
		const after = lines(600).map((text, index) => (index === 4 || index === 5 || index === 300 || index === 590 ? `${text}!` : text)).join("\n");
		expect(summariseMarkdownDiff(before, after)).toEqual({ added: 4, removed: 4, places: 3 });
		expect(summariseMarkdownDiff("same", "same")).toEqual({ added: 0, removed: 0, places: 0 });
	});

	test("describes a diff in plain words", () => {
		expect(describeMarkdownDiffSummary({ added: 2, removed: 2, places: 2 })).toBe("2 places changed: 2 lines added, 2 lines removed");
		expect(describeMarkdownDiffSummary({ added: 1, removed: 0, places: 1 })).toBe("1 place changed: 1 line added, 0 lines removed");
		expect(describeMarkdownDiffSummary({ added: 800, removed: 790, places: 3, approximate: true })).toBe("About 3 places changed: up to 800 lines added, up to 790 lines removed");
	});

	test("a full rewrite with nothing in common is exact", () => {
		expect(getMarkdownDiffStats(lines(1000, "old").join("\n"), lines(1000, "new").join("\n"))).toEqual({ added: 1000, removed: 1000 });
	});

	test("a huge rewrite that shares only repeated lines says its counts are approximate", () => {
		const before = Array.from({ length: 6000 }, (_, index) => (index % 2 === 0 ? "" : "- item"));
		const after = Array.from({ length: 6000 }, (_, index) => (index % 3 === 0 ? "" : "- item"));
		const stats = getMarkdownDiffStats(before.join("\n"), after.join("\n"));
		expect(stats.approximate).toBe(true);
		expect(stats.added).toBeGreaterThan(0);
	});
});

describe("diff correctness", () => {
	function lcsLength(a: string[], b: string[]): number {
		const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
		for (let i = a.length - 1; i >= 0; i -= 1) {
			for (let j = b.length - 1; j >= 0; j -= 1) {
				table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
			}
		}
		return table[0][0];
	}

	test("random small notes: the rows rebuild both texts and the counts are the minimum", () => {
		let seed = 20261012;
		const next = (): number => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return seed / 4294967296;
		};
		const vocabulary = ["a", "b", "c", "d", "", "e", "f"];
		const randomLines = (): string[] => Array.from({ length: Math.floor(next() * 30) }, () => vocabulary[Math.floor(next() * vocabulary.length)]);
		for (let iteration = 0; iteration < 400; iteration += 1) {
			const before = randomLines();
			const after = randomLines();
			const rows = buildMarkdownLineDiff(before.join("\n"), after.join("\n"));
			if (rows.length === 1 && rows[0].kind === "omitted") {
				expect(before.join("\n")).toBe(after.join("\n"));
				continue;
			}
			const rebuiltBefore = rows.filter((row) => row.kind === "context" || row.kind === "removed").map((row) => row.text);
			const rebuiltAfter = rows.filter((row) => row.kind === "context" || row.kind === "added").map((row) => row.text);
			expect(rebuiltBefore).toEqual(before.join("\n").split("\n"));
			expect(rebuiltAfter).toEqual(after.join("\n").split("\n"));
			const stats = getMarkdownDiffStats(before.join("\n"), after.join("\n"));
			const common = lcsLength(before.join("\n").split("\n"), after.join("\n").split("\n"));
			expect(stats.removed).toBe(before.join("\n").split("\n").length - common);
			expect(stats.added).toBe(after.join("\n").split("\n").length - common);
		}
	});

	test("line numbers in the rows point at the right lines", () => {
		const before = ["one", "two", "three", "four", "five"].join("\n");
		const after = ["one", "TWO", "three", "five", "six"].join("\n");
		const rows = buildMarkdownLineDiff(before, after);
		for (const row of rows) {
			if (row.oldLineNumber !== null) {
				expect(before.split("\n")[row.oldLineNumber - 1]).toBe(row.text);
			}
			if (row.newLineNumber !== null) {
				expect(after.split("\n")[row.newLineNumber - 1]).toBe(row.text);
			}
		}
	});
});
