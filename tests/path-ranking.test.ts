import { describe, expect, test } from "bun:test";
import { getQueryFolderPath, isHiddenVaultPath, rankPathSuggestions } from "../src/ui/settings/pathRanking";

const notes = [
	"Projects/AskMate/Glossary.md",
	"Style Guide.md",
	"Archive/Old Style Guide.md",
	"Glossary.md",
	"Projects/Alpha.md",
	"Daily/2026-10-01.md",
];

describe("rankPathSuggestions", () => {
	test("returns the first paths alphabetically for an empty or blank query", () => {
		expect(rankPathSuggestions(notes, "", 3)).toEqual(["Archive/Old Style Guide.md", "Daily/2026-10-01.md", "Glossary.md"]);
		expect(rankPathSuggestions(notes, "   ", 2)).toEqual(["Archive/Old Style Guide.md", "Daily/2026-10-01.md"]);
	});

	test("matches case-insensitively and keeps the original casing", () => {
		expect(rankPathSuggestions(notes, "GLOSS", 10)).toEqual(["Glossary.md", "Projects/AskMate/Glossary.md"]);
	});

	test("requires every whitespace-separated token to appear, in any order", () => {
		expect(rankPathSuggestions(notes, "guide style", 10)).toEqual(["Style Guide.md", "Archive/Old Style Guide.md"]);
		expect(rankPathSuggestions(notes, "style glossary", 10)).toEqual([]);
	});

	test("ranks a file name that starts with the query before a path that starts with it", () => {
		const paths = ["notes/a.md", "x/notes.md", "other/my-notes.md"];
		expect(rankPathSuggestions(paths, "notes", 10)).toEqual(["x/notes.md", "notes/a.md", "other/my-notes.md"]);
	});

	test("ranks a path prefix before a plain substring match", () => {
		const paths = ["Work/Projects/Plan.md", "Projects/Plan.md"];
		expect(rankPathSuggestions(paths, "projects/", 10)).toEqual(["Projects/Plan.md", "Work/Projects/Plan.md"]);
	});

	test("breaks ties by shorter path, then alphabetically", () => {
		const paths = ["Zeta/note-long.md", "b/note.md", "a/note.md", "Alpha/note.md"];
		expect(rankPathSuggestions(paths, "note", 10)).toEqual(["a/note.md", "b/note.md", "Alpha/note.md", "Zeta/note-long.md"]);
	});

	test("caps the result at the limit and treats a non-positive limit as no cap", () => {
		expect(rankPathSuggestions(notes, "md", 2)).toHaveLength(2);
		expect(rankPathSuggestions(notes, "md", 0)).toHaveLength(notes.length);
		expect(rankPathSuggestions(notes, "", -1)).toHaveLength(notes.length);
	});

	test("returns nothing when no path matches", () => {
		expect(rankPathSuggestions(notes, "zzz", 10)).toEqual([]);
		expect(rankPathSuggestions([], "a", 10)).toEqual([]);
	});

	test("does not mutate the input array", () => {
		const input = ["b.md", "a.md", "c.md"];
		const snapshot = [...input];
		rankPathSuggestions(input, "", 10);
		rankPathSuggestions(input, "md", 10);
		expect(input).toEqual(snapshot);
	});
});

describe("isHiddenVaultPath", () => {
	test("flags paths with a dot-prefixed segment at any depth", () => {
		expect(isHiddenVaultPath(".obsidian")).toBe(true);
		expect(isHiddenVaultPath(".trash/old.md")).toBe(true);
		expect(isHiddenVaultPath("Notes/.hidden/file.md")).toBe(true);
	});

	test("keeps ordinary paths, including names that merely contain dots", () => {
		expect(isHiddenVaultPath("Projects/AskMate")).toBe(false);
		expect(isHiddenVaultPath("v1.2/notes.md")).toBe(false);
	});
});

describe("getQueryFolderPath", () => {
	test("returns the vault root while no folder has been typed", () => {
		expect(getQueryFolderPath("")).toBe("");
		expect(getQueryFolderPath("Glossary")).toBe("");
		expect(getQueryFolderPath("/Glossary")).toBe("");
	});

	test("returns the folder part of a typed path", () => {
		expect(getQueryFolderPath("Projects/")).toBe("Projects");
		expect(getQueryFolderPath("Projects/AskMate/Glo")).toBe("Projects/AskMate");
		expect(getQueryFolderPath("  Projects//Glo ")).toBe("Projects");
	});
});
