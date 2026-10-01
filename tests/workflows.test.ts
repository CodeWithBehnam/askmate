import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import type { Workflow } from "../src/shared/types";
import { NOTE_LANGUAGE_RULE, WORKFLOWS } from "../src/workflows/builtInWorkflows";

function resolvePrompt(workflow: Workflow): string {
	return typeof workflow.prompt === "function" ? workflow.prompt(structuredClone(DEFAULT_SETTINGS)) : workflow.prompt;
}

// Ids and command ids are persisted in settings, hotkeys and display preferences, so renaming one silently breaks users.
const EXPECTED_IDS = [
	"study-summary",
	"action-plan",
	"explain-simply",
	"question-drill",
	"buyer-protection-analysis",
	"knowledge-graph-links",
	"mermaid-diagram",
	"key-insights",
	"critical-review",
	"pros-cons",
	"flashcards",
	"meeting-notes",
	"research-map",
	"decision-brief",
	"compare-ideas",
	"translate-preserve",
	"quote-extractor",
	"rewrite-polish"
];

describe("built-in workflows", () => {
	test("keep a stable id list with matching, unique command ids", () => {
		expect(WORKFLOWS.map((workflow) => workflow.id)).toEqual(EXPECTED_IDS);
		expect(new Set(WORKFLOWS.map((workflow) => workflow.id)).size).toBe(WORKFLOWS.length);
		expect(new Set(WORKFLOWS.map((workflow) => workflow.commandId)).size).toBe(WORKFLOWS.length);
		for (const workflow of WORKFLOWS) {
			expect(workflow.commandId).toBe(`workflow-${workflow.id}`);
		}
	});

	test("set an output kind on every workflow, with only full-note transforms as note-edit", () => {
		const noteEditIds = WORKFLOWS.filter((workflow) => workflow.outputKind === "note-edit").map((workflow) => workflow.id);

		expect(WORKFLOWS.every((workflow) => workflow.outputKind === "note-edit" || workflow.outputKind === "new-content")).toBe(true);
		expect(noteEditIds.sort()).toEqual(["rewrite-polish", "translate-preserve"]);
	});

	test("have non-empty prompts with goal, success criteria, constraints, output and stop rules", () => {
		for (const workflow of WORKFLOWS) {
			const prompt = resolvePrompt(workflow);

			expect(prompt.trim().length).toBeGreaterThan(0);
			for (const section of ["Goal:", "Success criteria:", "Constraints:", "Output:", "Stop rules:"]) {
				expect(prompt).toContain(section);
			}
		}
	});

	test("do not force British English on note content", () => {
		for (const workflow of WORKFLOWS) {
			expect(resolvePrompt(workflow)).not.toContain("British English");
		}
	});

	test("keep the note's language in every new-content workflow", () => {
		for (const workflow of WORKFLOWS.filter((item) => item.outputKind === "new-content")) {
			expect(resolvePrompt(workflow)).toContain(NOTE_LANGUAGE_RULE);
		}
	});

	test("note-edit prompts preserve Obsidian syntax and return only the revised note", () => {
		const preservedTokens = ["frontmatter", "%%", "[[", "![[", "^id", "[^label]", "#tag", "> [!", "$$", "code"];

		for (const workflow of WORKFLOWS.filter((item) => item.outputKind === "note-edit")) {
			const prompt = resolvePrompt(workflow);

			for (const token of preservedTokens) {
				expect(prompt).toContain(token);
			}
			expect(prompt).toContain("byte-for-byte identical");
			expect(prompt).toMatch(/Return only the/);
			expect(prompt).toMatch(/no preamble|No preamble/);
		}
	});

	test("rewrite polish forbids commentary and source IDs in text that gets applied", () => {
		const prompt = resolvePrompt(WORKFLOWS.find((workflow) => workflow.id === "rewrite-polish") ?? WORKFLOWS[0]);

		expect(prompt).toContain("[S1]");
		expect(prompt).toContain("remarks about limitations");
		expect(prompt).not.toContain("keeping that limitation clear");
		expect(prompt).toContain("Do not add headings");
	});

	test("knowledge graph links keep suggestions inert until accepted", () => {
		const prompt = resolvePrompt(WORKFLOWS.find((workflow) => workflow.id === "knowledge-graph-links") ?? WORKFLOWS[0]);
		const bareWikilinks = prompt.replace(/`[^`]*`/g, "").replace(/as \[\[Name\]\]/g, "").match(/\[\[[^\]]+\]\]/g);

		expect(prompt).toContain("must not create graph links");
		expect(prompt).toContain("inline code");
		expect(prompt).toContain("fenced code block");
		// The prompt itself demonstrates the format, so its own examples must not model bare wikilinks.
		expect(bareWikilinks).toBeNull();
	});
});
