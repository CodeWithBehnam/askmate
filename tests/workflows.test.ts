import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { buildTranslatePreservePrompt } from "../src/settings/normalize";
import type { Workflow } from "../src/shared/types";
import * as builtIns from "../src/workflows/builtInWorkflows";
import { NOTE_LANGUAGE_RULE, WORKFLOWS } from "../src/workflows/builtInWorkflows";
import * as promptRules from "../src/workflows/promptRules";

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

function workflowById(id: string): Workflow {
	const workflow = WORKFLOWS.find((item) => item.id === id);
	if (!workflow) {
		throw new Error(`Missing built-in workflow ${id}`);
	}
	return workflow;
}

describe("built-in workflow names", () => {
	const EXPECTED_NAMES = [
		"Study summary",
		"Action plan",
		"Explain simply",
		"Question drill",
		"Buyer protection analysis",
		"Knowledge graph links",
		"Mermaid diagram",
		"Key insights",
		"Critical review",
		"Pros and cons",
		"Flashcards",
		"Meeting notes",
		"Research map",
		"Decision brief",
		"Compare ideas",
		"Translate and preserve",
		"Quote extractor",
		"Rewrite polish"
	];

	test("are sentence case and keep their order", () => {
		expect(WORKFLOWS.map((workflow) => workflow.name)).toEqual(EXPECTED_NAMES);
	});

	test("capitalise only the first word, as Obsidian's sentence-case guidance asks", () => {
		for (const workflow of WORKFLOWS) {
			expect(workflow.name).toMatch(/^[A-Z][^A-Z]*$/);
		}
	});

	test("keep the short names that become command slugs", () => {
		expect(WORKFLOWS.map((workflow) => workflow.shortName)).toEqual([
			"Summarise", "Plan", "Explain", "Drill", "Protect", "Links", "Diagram", "Insights", "Critique", "Pros/Cons", "Cards", "Meeting", "Research", "Decision", "Compare", "Translate", "Quotes", "Polish"
		]);
	});
});

describe("built-in prompt lint", () => {
	test("no prompt contains a {{placeholder}} that would be mistaken for a template variable", () => {
		for (const workflow of WORKFLOWS) {
			expect(resolvePrompt(workflow)).not.toMatch(/\{\{\s*\w+\s*\}\}/);
		}
	});

	test("every prompt keeps the Goal, Success criteria, Constraints, Output, Stop rules skeleton in order", () => {
		for (const workflow of WORKFLOWS) {
			const prompt = resolvePrompt(workflow);
			const positions = ["Goal:", "Success criteria:", "Constraints:", "Output:", "Stop rules:"].map((section) => prompt.indexOf(section));
			expect(positions.every((position) => position >= 0)).toBe(true);
			expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		}
	});

	test("no prompt uses absolute wording for something a model cannot guarantee", () => {
		for (const workflow of WORKFLOWS) {
			expect(resolvePrompt(workflow)).not.toMatch(/\b(?:ALWAYS|NEVER|MUST)\b/);
		}
	});
});

describe("table cell rule", () => {
	test("is exported from the shared rules and re-exported by the workflow module", () => {
		expect(promptRules.TABLE_CELL_RULE).toContain("one line");
		expect(promptRules.TABLE_CELL_RULE).toContain("\\|");
		expect(promptRules.TABLE_CELL_RULE).toContain("<br>");
		expect(builtIns.TABLE_CELL_RULE).toBe(promptRules.TABLE_CELL_RULE);
	});

	test("every built-in prompt that mentions a table also carries it", () => {
		const mentioning = WORKFLOWS.filter((workflow) => /\btables?\b/i.test(resolvePrompt(workflow)));
		expect(mentioning.length).toBeGreaterThanOrEqual(5);
		for (const workflow of mentioning) {
			expect(resolvePrompt(workflow)).toContain(promptRules.TABLE_CELL_RULE);
		}
	});

	test("the five table-producing workflows are among them", () => {
		for (const id of ["question-drill", "knowledge-graph-links", "pros-cons", "flashcards", "compare-ideas"]) {
			expect(resolvePrompt(workflowById(id))).toContain(promptRules.TABLE_CELL_RULE);
		}
	});
});

describe("shared note-edit rules", () => {
	const noteEditIds = ["rewrite-polish", "translate-preserve"];

	test("rewrite and translate both preserve inline fields and HTML tags and forbid a code fence", () => {
		for (const id of noteEditIds) {
			const prompt = resolvePrompt(workflowById(id));
			expect(prompt).toContain("key::");
			expect(prompt).toContain("HTML tags");
			expect(prompt).toContain("code fence");
			expect(prompt).toContain("source IDs such as [S1]");
		}
	});

	test("the translate prompt built in settings is the one the workflow uses", () => {
		expect(resolvePrompt(workflowById("translate-preserve"))).toBe(buildTranslatePreservePrompt(DEFAULT_SETTINGS.translationTargetLanguage));
	});

	test("the shared constants are the same values the workflow module exports", () => {
		expect(builtIns.NOTE_LANGUAGE_RULE).toBe(promptRules.NOTE_LANGUAGE_RULE);
		expect(builtIns.OBSIDIAN_SYNTAX_RULE).toBe(promptRules.OBSIDIAN_SYNTAX_RULE);
		expect(builtIns.NOTE_EDIT_OUTPUT_RULE).toBe(promptRules.NOTE_EDIT_OUTPUT_RULE);
		expect(resolvePrompt(workflowById("rewrite-polish"))).toContain(promptRules.NOTE_EDIT_OUTPUT_RULE);
		expect(promptRules.NOTE_EDIT_OUTPUT_RULE.endsWith("Do not wrap it in a code fence.")).toBe(true);
	});

	test("the syntax rule builder lists the shared items for any variant", () => {
		const rule = promptRules.buildPreservedSyntaxRule({ wikilinks: "wikilink targets", callouts: "callout markers", extras: ["file paths"] });
		for (const item of ["YAML frontmatter", "code blocks and inline code", "inline fields (key:: value)", "HTML tags", "wikilink targets", "callout markers", "file paths"]) {
			expect(rule).toContain(item);
		}
		expect(rule.startsWith("These stay byte-for-byte identical:")).toBe(true);
		expect(rule.endsWith(".")).toBe(true);
	});

	test("the translate prompt still lets labels be translated and keeps targets fixed", () => {
		const prompt = resolvePrompt(workflowById("translate-preserve"));
		expect(prompt).toContain("[[target|translated label]]");
		expect(prompt).toContain("never the target");
		expect(prompt).toContain("callout type keywords");
		expect(prompt).toContain("file paths, commands and IDs");
		expect(prompt).toContain("Text already in the target language stays unchanged");
	});
});

describe("knowledge graph links", () => {
	const prompt = (): string => resolvePrompt(workflowById("knowledge-graph-links"));

	test("no longer claims an unconditional inability to see other notes", () => {
		expect(prompt()).not.toContain("You cannot see the user's other notes, so do not claim that a note exists.");
	});

	test("the invisibility rule applies only without attached vault notes", () => {
		const text = prompt();
		expect(text).toContain("vault_note");
		expect(text).toContain("folder_note");
		expect(text).toContain("additional_note");
		expect(text).toMatch(/Unless .*vault_note.*you cannot see the user's other notes/);
	});

	test("prefers exact attached titles and says which suggestions match an attached note", () => {
		const text = prompt();
		expect(text).toContain("exact titles");
		expect(text).toMatch(/say which suggestions (?:match|are) an attached note/);
	});
});

describe("mermaid diagram workflow", () => {
	const workflow = (): Workflow => workflowById("mermaid-diagram");
	const prompt = (): string => resolvePrompt(workflow());

	test("is a thin entry that applies the built-in mermaid skill", () => {
		expect(workflow().skillIds).toEqual(["built-in:mermaid-diagrams"]);
		expect(prompt().length).toBeLessThan(1600);
	});

	test("keeps its stable ids and output kind", () => {
		expect(workflow().id).toBe("mermaid-diagram");
		expect(workflow().commandId).toBe("workflow-mermaid-diagram");
		expect(workflow().outputKind).toBe("new-content");
	});

	test("drops the lines that contradicted a distinctive result", () => {
		expect(prompt()).not.toMatch(/prefer a simple/i);
		expect(prompt()).not.toMatch(/alternative/i);
		expect(prompt()).not.toMatch(/explain the process/i);
	});

	test("asks for one valid diagram in a mermaid fence and forbids source IDs", () => {
		expect(prompt()).toContain("language mermaid");
		expect(prompt()).toContain("source IDs such as [S1]");
		expect(prompt()).toContain(NOTE_LANGUAGE_RULE);
	});

	test("agrees with the diagram skill: one block, an optional plain sentence, the line break allowed, quoting left to the skill", () => {
		const text = prompt();
		expect(text).toContain("<br/> line break");
		expect(text).not.toMatch(/links or HTML\./);
		expect(text).toContain("only if you assumed something or left something out");
		expect(text).toContain("nothing to draw, say so in one sentence without a code block");
		expect(text).toContain("Follow the diagram skill and the design brief");
		expect(text).not.toContain("Quote any label");
		expect(text).not.toMatch(/Shows:|Assumptions:/);
	});

	test("is the only built-in workflow that names skills", () => {
		const withSkills = WORKFLOWS.filter((item) => item.skillIds !== undefined).map((item) => item.id);
		expect(withSkills).toEqual(["mermaid-diagram"]);
	});
});
