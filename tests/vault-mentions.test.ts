import { describe, expect, test } from "bun:test";
import {
	MAX_NOTES_PER_VAULT_MENTION,
	MAX_RECENT_COUNT,
	VaultMentionError,
	describeVaultMentionResolutions,
	noteHasTag,
	normaliseTag,
	parseRecentCount,
	rankVaultTags,
	resolveVaultMentions,
	selectBacklinkPaths,
	selectLinkedPaths,
	selectRecentPaths,
	selectTaggedPaths,
	type VaultData,
	type VaultNoteMeta
} from "../src/context/vaultMentions";

const note = (path: string, mtime: number, tags: string[] = []): VaultNoteMeta => ({ path, mtime, tags });

const notes: VaultNoteMeta[] = [
	note("Current.md", 50, ["#project"]),
	note("A.md", 10, ["#project/alpha"]),
	note("B.md", 30, ["#Project"]),
	note("C.md", 20, ["#projects"]),
	note("D.md", 40, ["#reading"]),
	note("diagram.png", 60)
];

const data: VaultData = {
	resolvedLinks: {
		"Current.md": { "A.md": 1, "B.md": 3, "diagram.png": 1, "Current.md": 1 },
		"A.md": { "Current.md": 2 },
		"B.md": { "Current.md": 2 },
		"C.md": { "Current.md": 5 },
		"D.md": { "A.md": 1 }
	},
	orderedLinkTargets: ["B.md", "diagram.png", "A.md", "B.md", "Current.md"],
	notes
};

describe("normaliseTag", () => {
	test("accepts a tag with or without #, in any case", () => {
		expect(normaliseTag("#Project/Alpha")).toBe("project/alpha");
		expect(normaliseTag("project")).toBe("project");
		expect(normaliseTag("project/")).toBe("project");
	});

	test("rejects empty or spaced tags", () => {
		expect(normaliseTag("")).toBeNull();
		expect(normaliseTag("#")).toBeNull();
		expect(normaliseTag("two words")).toBeNull();
	});
});

describe("parseRecentCount", () => {
	test("defaults, clamps and rejects", () => {
		expect(parseRecentCount(undefined)).toBe(5);
		expect(parseRecentCount("")).toBe(5);
		expect(parseRecentCount("3")).toBe(3);
		expect(parseRecentCount("500")).toBe(MAX_RECENT_COUNT);
		expect(parseRecentCount("0")).toBeNull();
		expect(parseRecentCount("abc")).toBeNull();
		expect(parseRecentCount("2.5")).toBeNull();
	});

	test("the largest count it accepts is the number of notes one mention can attach (CTX-02)", () => {
		expect(MAX_RECENT_COUNT).toBe(MAX_NOTES_PER_VAULT_MENTION);
	});

	test("every count it returns is honoured in full by resolveVaultMentions", () => {
		const many = Array.from({ length: 40 }, (_, index) => note(`N${String(index).padStart(2, "0")}.md`, index));
		for (let requested = 1; requested <= MAX_RECENT_COUNT + 15; requested += 1) {
			const count = parseRecentCount(String(requested));
			expect(count).not.toBeNull();
			const [resolution] = resolveVaultMentions([{ kind: "recent", count: count ?? 1 }], "Current.md", { resolvedLinks: {}, orderedLinkTargets: [], notes: many });
			expect(resolution?.included).toHaveLength(count ?? 0);
			expect(resolution?.dropped).toEqual([]);
		}
	});
});

describe("selectLinkedPaths", () => {
	test("orders by first appearance, drops duplicates, self and non-Markdown files", () => {
		expect(selectLinkedPaths("Current.md", data)).toEqual(["B.md", "A.md"]);
	});

	test("falls back to link count then path for resolved links that were not seen in order", () => {
		const fallback = selectLinkedPaths("Current.md", { resolvedLinks: data.resolvedLinks, orderedLinkTargets: [] });
		expect(fallback).toEqual(["B.md", "A.md"]);
		const tied = selectLinkedPaths("X.md", { resolvedLinks: { "X.md": { "Z.md": 1, "M.md": 1, "Q.md": 4 } }, orderedLinkTargets: [] });
		expect(tied).toEqual(["Q.md", "M.md", "Z.md"]);
	});

	test("is empty for a note without links", () => {
		expect(selectLinkedPaths("D2.md", { resolvedLinks: {}, orderedLinkTargets: [] })).toEqual([]);
	});
});

describe("selectBacklinkPaths", () => {
	test("orders by link count, then most recently modified, and excludes the note itself", () => {
		expect(selectBacklinkPaths("Current.md", data)).toEqual(["C.md", "B.md", "A.md"]);
	});

	test("ignores sources that do not link to the note", () => {
		expect(selectBacklinkPaths("A.md", data)).toEqual(["Current.md", "D.md"]);
	});
});

describe("tags", () => {
	test("noteHasTag matches the tag and nested children only", () => {
		expect(noteHasTag(["#project/alpha"], "project")).toBe(true);
		expect(noteHasTag(["#Project"], "project")).toBe(true);
		expect(noteHasTag(["#projects"], "project")).toBe(false);
		expect(noteHasTag(["#project"], "project/alpha")).toBe(false);
	});

	test("selectTaggedPaths is case-insensitive, includes nested tags, excludes the current note, newest first", () => {
		expect(selectTaggedPaths("#PROJECT", "Current.md", notes)).toEqual(["B.md", "A.md"]);
		expect(selectTaggedPaths("project/alpha", "Current.md", notes)).toEqual(["A.md"]);
	});

	test("an unusable tag selects nothing", () => {
		expect(selectTaggedPaths("#", "Current.md", notes)).toEqual([]);
	});
});

describe("rankVaultTags", () => {
	test("lists distinct tags, most used first, ignoring case", () => {
		expect(rankVaultTags([note("a.md", 1, ["#b", "#a"]), note("b.md", 1, ["#B", "#a"]), note("c.md", 1, ["#c", "#a"])])).toEqual(["#a", "#b", "#c"]);
	});
});

describe("selectRecentPaths", () => {
	test("returns the newest Markdown notes without the current one", () => {
		expect(selectRecentPaths(2, "Current.md", notes)).toEqual(["D.md", "B.md"]);
	});

	test("clamps the count", () => {
		expect(selectRecentPaths(0, "Current.md", notes)).toHaveLength(1);
		expect(selectRecentPaths(99, "Current.md", notes)).toHaveLength(4);
		const many = Array.from({ length: 30 }, (_, index) => note(`M${index}.md`, index));
		expect(selectRecentPaths(99, "Current.md", many)).toHaveLength(MAX_RECENT_COUNT);
	});
});

describe("resolveVaultMentions", () => {
	test("labels each mention with its relation and attaches a note once", () => {
		const result = resolveVaultMentions(
			[{ kind: "links" }, { kind: "backlinks" }, { kind: "tag", tag: "project" }],
			"Current.md",
			data
		);
		expect(result.map((entry) => entry.relation)).toEqual(["linked from current note", "backlink to current note", "tag #project"]);
		expect(result[0].included).toEqual(["B.md", "A.md"]);
		expect(result[1].included).toEqual(["C.md"]);
		expect(result[2].included).toEqual([]);
	});

	test("caps each mention and reports what was left out", () => {
		const many = Array.from({ length: 14 }, (_, index) => note(`N${String(index).padStart(2, "0")}.md`, index, ["#bulk"]));
		const result = resolveVaultMentions([{ kind: "tag", tag: "bulk" }], "Current.md", { resolvedLinks: {}, orderedLinkTargets: [], notes: many });
		expect(result[0].included).toHaveLength(MAX_NOTES_PER_VAULT_MENTION);
		expect(result[0].dropped).toHaveLength(4);
		expect(result[0].included[0]).toBe("N13.md");
	});

	test("notes already attached elsewhere are skipped and reported, not attached again (CTX-01)", () => {
		const taken = new Set(["B.md"]);
		const result = resolveVaultMentions([{ kind: "links" }], "Current.md", data, MAX_NOTES_PER_VAULT_MENTION, taken);
		expect(result[0].included).toEqual(["A.md"]);
		expect(result[0].duplicates).toEqual(["B.md"]);
		expect(taken.has("A.md")).toBe(true);
	});

	test("a mention whose notes are all attached elsewhere is not an error", () => {
		const result = resolveVaultMentions([{ kind: "backlinks" }], "A.md", data, MAX_NOTES_PER_VAULT_MENTION, new Set(["Current.md", "D.md"]));
		expect(result[0].included).toEqual([]);
		expect(result[0].duplicates).toEqual(["Current.md", "D.md"]);
	});

	test("a note selected by an earlier mention is reported as a duplicate of the later one", () => {
		const result = resolveVaultMentions([{ kind: "links" }, { kind: "tag", tag: "project" }], "Current.md", data);
		expect(result[0].included).toEqual(["B.md", "A.md"]);
		expect(result[1].included).toEqual([]);
		expect(result[1].duplicates).toEqual(["B.md", "A.md"]);
	});

	test("zero results are an error that names the mention", () => {
		const empty: VaultData = { resolvedLinks: {}, orderedLinkTargets: [], notes: [note("Only.md", 1)] };
		const message = (mention: Parameters<typeof resolveVaultMentions>[0][number]): string => {
			try {
				resolveVaultMentions([mention], "Only.md", empty);
			} catch (error) {
				expect(error).toBeInstanceOf(VaultMentionError);
				return (error as Error).message;
			}
			return "";
		};
		expect(message({ kind: "links" })).toContain("@links");
		expect(message({ kind: "backlinks" })).toContain("@backlinks");
		expect(message({ kind: "tag", tag: "nope" })).toContain("#nope");
		expect(message({ kind: "recent", count: 5 })).toContain("@recent");
	});

	test("links and backlinks need a current note, tag and recent do not", () => {
		expect(() => resolveVaultMentions([{ kind: "links" }], null, data)).toThrow(VaultMentionError);
		expect(() => resolveVaultMentions([{ kind: "backlinks" }], null, data)).toThrow("needs a note");
		expect(resolveVaultMentions([{ kind: "tag", tag: "reading" }], null, data)[0].included).toEqual(["D.md"]);
	});

	test("the preview lists included and dropped notes", () => {
		const lines = describeVaultMentionResolutions([
			{ mention: { kind: "recent", count: 5 }, label: "@recent:5", relation: "recently modified", included: ["A.md", "B.md"], dropped: ["C.md"], overBudget: ["D.md"] },
			{ mention: { kind: "links" }, label: "@links", relation: "linked from current note", included: [], dropped: [], overBudget: [] }
		]);
		expect(lines[0]).toBe("mention   @recent:5: A.md, B.md; 1 more left out by the 10-note cap; 1 not read, character limit reached (D.md)");
		expect(lines[1]).toBe("mention   @links: nothing new");
	});
});
