import { describe, expect, test } from "bun:test";
import { buildConsoleCommands } from "../src/ui/sidebar/consoleCommands";
import { WORKFLOWS } from "../src/workflows/builtInWorkflows";
import { canUndoDraft, DRAFT_SEPARATOR, mergeIntoDraft } from "../src/ui/sidebar/components/composerDraft";
import { describeOutputBadge, modeAfterRun } from "../src/ui/sidebar/components/outputMode";
import { COMMAND_HINT, parsePlainComposerCommand, resolveDraftRequest, type DraftDeps } from "../src/ui/sidebar/components/draftRequest";
import { DEFAULT_IMAGE_PROMPT } from "../src/settings/constants";
import type { RunRequestOptions } from "../src/shared/types";

describe("mergeIntoDraft", () => {
	test("puts text into an empty composer as it is", () => {
		expect(mergeIntoDraft("", "  What is this?  ")).toEqual({ text: "What is this?", appended: false, previous: null });
		expect(mergeIntoDraft("   \n", "Again")).toMatchObject({ text: "Again", appended: false });
	});

	test("adds below a separator when a draft exists, and keeps the draft for undo", () => {
		const change = mergeIntoDraft("my half-written question", "the earlier reply");
		expect(change.text).toBe(`my half-written question${DRAFT_SEPARATOR}the earlier reply`);
		expect(change.appended).toBe(true);
		expect(change.previous).toBe("my half-written question");
	});

	test("never loses the draft, and does not add the same text twice", () => {
		expect(mergeIntoDraft("keep me", "").text).toBe("keep me");
		expect(mergeIntoDraft("same", "same")).toMatchObject({ text: "same", appended: false });
		const first = mergeIntoDraft("draft", "reply");
		expect(mergeIntoDraft(first.text, "reply").appended).toBe(false);
	});

	test("undo is offered only while the composer still holds the merged text", () => {
		const change = mergeIntoDraft("draft", "reply");
		const undo = { previous: change.previous ?? "", merged: change.text };
		expect(canUndoDraft(undo, change.text)).toBe(true);
		expect(canUndoDraft(undo, `${change.text} edited`)).toBe(false);
		expect(canUndoDraft(null, "x")).toBe(false);
	});
});

describe("output mode is for one request", () => {
	test("a note or apply mode from settings is spent by the request that uses it", () => {
		expect(modeAfterRun({ mode: "note", fromSetting: true })).toBe("chat");
		expect(modeAfterRun({ mode: "apply", fromSetting: true })).toBe("chat");
	});

	test("chat stays, and a mode typed in the command never touches the setting", () => {
		expect(modeAfterRun({ mode: "chat", fromSetting: true })).toBeNull();
		expect(modeAfterRun({ mode: "note", fromSetting: false })).toBeNull();
	});

	test("a badge shows whenever the mode is not chat", () => {
		expect(describeOutputBadge("chat")).toBeNull();
		expect(describeOutputBadge("note")?.tone).toBe("note");
		expect(describeOutputBadge("apply")?.label).toContain("apply");
	});
});

describe("resolveDraftRequest", () => {
	const commands = buildConsoleCommands(WORKFLOWS);
	const summary = WORKFLOWS.find((workflow) => workflow.id === "study-summary");
	if (!summary) {
		throw new Error("expected the study summary workflow");
	}
	const deps = (overrides: Partial<DraftDeps> = {}): DraftDeps => ({
		isConsole: true,
		commands,
		baseOptions: (forceImage) => ({ forceImage }),
		applyMentions: (options: RunRequestOptions) => options,
		findWorkflow: (id) => WORKFLOWS.find((workflow) => workflow.id === id),
		workflowPrompt: (workflow) => `PROMPT:${workflow.id}`,
		...overrides
	});

	test("a plain question is an answer", () => {
		expect(resolveDraftRequest("What is this?", deps())).toMatchObject({ kind: "request", draftKind: "answer", question: "What is this?", forceImage: false });
	});

	test("a workflow command previews the workflow, not the typed command", () => {
		const resolved = resolveDraftRequest("/summarise focus on dates", deps());
		expect(resolved.kind).toBe("request");
		if (resolved.kind !== "request") {
			return;
		}
		expect(resolved.draftKind).toBe("workflow");
		expect(resolved.question).toBe("PROMPT:study-summary");
		expect(resolved.title).toBe(summary.name);
		expect(resolved.options.workflow?.id).toBe("study-summary");
		expect(resolved.options.workflowExtra).toBe("focus on dates");
	});

	test("commands that send no request give a neutral hint", () => {
		for (const line of ["/model", "/provider openai", "/threads", "/export", "/help", "/clear", "/setup", "/skills"]) {
			const resolved = resolveDraftRequest(line, deps());
			expect(resolved).toEqual({ kind: "none", hint: COMMAND_HINT });
		}
	});

	test("a parse error says what is wrong", () => {
		const resolved = resolveDraftRequest("/nonsense", deps());
		expect(resolved.kind).toBe("none");
		expect(resolved.kind === "none" && resolved.hint).toContain("Unknown command");
	});

	test("a mention that cannot be honoured is reported, not hidden", () => {
		const resolved = resolveDraftRequest("@folder what is here", deps({
			applyMentions: () => {
				throw new Error("@folder: there is no folder called \"X\" in this vault.");
			}
		}));
		expect(resolved).toEqual({ kind: "none", hint: "@folder: there is no folder called \"X\" in this vault." });
	});

	test("/image previews an image request", () => {
		expect(resolveDraftRequest("/image a lighthouse", deps())).toMatchObject({ kind: "request", draftKind: "image", forceImage: true, question: "a lighthouse" });
	});

	test("/diagram previews a diagram request that applies the diagram skill", () => {
		const resolved = resolveDraftRequest("/diagram the login flow", deps());
		expect(resolved.kind).toBe("request");
		if (resolved.kind !== "request") {
			return;
		}
		expect(resolved.draftKind).toBe("diagram");
		expect(resolved.question).toBe("the login flow");
		expect(resolved.options.intentKind).toBe("diagram");
		expect(resolved.skillNames).toContain("built-in:mermaid-diagrams");
		const bare = resolveDraftRequest("/diagram", deps());
		expect(bare.kind === "request" && bare.question).toBe("Draw a Mermaid diagram of this note.");
	});

	test("a skill named in the line is carried with the question", () => {
		const resolved = resolveDraftRequest("@skill:meeting-notes what happened?", deps());
		expect(resolved.kind === "request" && resolved.skillNames).toEqual(["meeting-notes"]);
		const slash = resolveDraftRequest("/skill meeting-notes what happened?", deps());
		expect(slash.kind === "request" && slash.skillNames).toEqual(["meeting-notes"]);
		expect(resolveDraftRequest("/skill meeting-notes", deps()).kind).toBe("none");
	});

	test("outside the console only /image is special", () => {
		const plain = deps({ isConsole: false });
		expect(resolveDraftRequest("/model", plain)).toMatchObject({ kind: "request", question: "/model", draftKind: "answer" });
		expect(resolveDraftRequest("/img a fox", plain)).toMatchObject({ draftKind: "image", question: "a fox", forceImage: true });
	});

	test("an empty /image uses the default prompt", () => {
		expect(parsePlainComposerCommand("/image").question).toBe(DEFAULT_IMAGE_PROMPT);
	});
});
