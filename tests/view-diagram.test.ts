import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderDiagramCard, type DiagramCardActions, type DiagramCardHandle, type DiagramPreviewHost, type DrawResult } from "../src/ui/sidebar/components/DiagramCard";
import {
	buildFixQuestion,
	canonicalDiagramText,
	describeDiagramCard,
	diagramCardStatus,
	diagramKindLabel,
	diagramStyleLabel,
	fenceDiagram,
	firstLook,
	MAX_FIX_SOURCE_CHARACTERS,
	nextLook,
	proseAroundDiagram,
	savedDiagramSummary,
	withDiagramMetadata
} from "../src/ui/sidebar/components/diagramModel";
import type { DiagramRunResult } from "../src/requests/runTypes";
import type { AskRequest } from "../src/shared/types";
import { createFakeEl, installDomGlobals } from "./support/fake-dom";

const SOURCE = "flowchart TD\n  A[Start] --> B[End]";
const valid: DiagramRunResult = { status: "valid", kind: "flowchart", style: "blueprint", source: SOURCE };
const repaired: DiagramRunResult = { ...valid, status: "repaired", style: "slate" };
const fallback: DiagramRunResult = { status: "fallback", kind: "sequence", style: "auto", source: "sequenceDiagram\n  A->>", errors: ["Parse error on line 2", "Expecting 'ACTOR'", "", "a", "b", "c"] };

describe("diagram card wording", () => {
	test("names the kind and the look", () => {
		expect(diagramKindLabel("flowchart")).toBe("Flowchart");
		expect(diagramKindLabel("gitGraph")).toBe("Git graph");
		expect(diagramKindLabel("mystery")).toBe("Mystery diagram");
		expect(diagramStyleLabel("blueprint")).toBe("Blueprint");
		expect(diagramStyleLabel("Grape Soda")).toBe("Grape Soda");
	});

	test("a drawn diagram can be inserted when a note is open", () => {
		const copy = describeDiagramCard(valid, { hasNote: true });
		expect(copy.title).toBe("Flowchart");
		expect(copy.meta).toBe("Blueprint look");
		expect(copy.blockedReason).toBeNull();
		expect(diagramCardStatus(valid)).toBe("drawn");
	});

	test("with no note open, Insert says why it is off", () => {
		expect(describeDiagramCard(valid, { hasNote: false }).blockedReason).toBe("Open a note to insert the diagram into it.");
	});

	test("a repaired diagram says so", () => {
		expect(describeDiagramCard(repaired, { hasNote: true }).meta).toBe("Slate look · Repaired once");
	});

	test("a fallback blocks insert and save, keeps at most four error lines and explains", () => {
		const copy = describeDiagramCard(fallback, { hasNote: true });
		expect(copy.blockedReason).toContain("cannot be inserted or saved");
		expect(copy.fallbackMessage).toContain("source is shown below");
		expect(copy.errors).toEqual(["Parse error on line 2", "Expecting 'ACTOR'", "a", "b"]);
		expect(diagramCardStatus(fallback)).toBe("fallback");
	});
});

describe("looks and fixes", () => {
	const request = { question: "Draw it", metadata: { intentKind: "diagram" } } as unknown as AskRequest;

	test("the first look starts at zero with the settings defaults", () => {
		expect(firstLook({ defaultType: "auto", defaultStyle: "auto" })).toEqual({ kind: "auto", style: "auto", nonce: 0 });
		expect(firstLook({ defaultType: "", defaultStyle: "" })).toEqual({ kind: "auto", style: "auto", nonce: 0 });
	});

	test("Another look moves the counter on and hands the style back to the automatic cycle", () => {
		const next = nextLook({ kind: "flowchart", style: "blueprint", nonce: 2 }, { defaultType: "auto", defaultStyle: "slate" });
		expect(next).toEqual({ kind: "flowchart", style: "auto", nonce: 3 });
		expect(nextLook(undefined, { defaultType: "auto", defaultStyle: "auto" })).toEqual({ kind: "auto", style: "auto", nonce: 1 });
	});

	test("the request carries the look without changing the original", () => {
		const changed = withDiagramMetadata(request, { kind: "auto", style: "auto", nonce: 1 });
		expect(changed.metadata.diagram).toEqual({ kind: "auto", style: "auto", nonce: 1 });
		expect(request.metadata.diagram).toBeUndefined();
		expect(changed.question).toBe("Draw it");
	});

	test("Fix sends the source and the first lines Mermaid reported", () => {
		const question = buildFixQuestion(fallback);
		expect(question).toContain("Fix this Mermaid diagram");
		expect(question).toContain("Parse error on line 2");
		expect(question).toContain("```mermaid\nsequenceDiagram\n  A->>\n```");
		expect(question).not.toContain("\nc\n");
	});

	test("a very long source is cut so the fix request stays small", () => {
		const long = { ...fallback, source: `flowchart TD\n${"A-->B\n".repeat(5000)}` };
		expect(buildFixQuestion(long).length).toBeLessThan(MAX_FIX_SOURCE_CHARACTERS + 600);
	});

	test("the saved reply keeps the words and the diagram source, and the summary keeps the outcome", () => {
		const text = "Here is the flow.\n\n```mermaid\nflowchart TD\n  X-->Y\n```\n\nIt shows the steps.";
		expect(proseAroundDiagram(text)).toBe("Here is the flow.\n\nIt shows the steps.");
		expect(canonicalDiagramText(text, valid)).toBe(`Here is the flow.\n\nIt shows the steps.\n\n${fenceDiagram(SOURCE)}`);
		expect(savedDiagramSummary(valid)).toEqual({ type: "flowchart", status: "rendered", recipe: "Blueprint" });
		expect(savedDiagramSummary(repaired)).toEqual({ type: "flowchart", status: "rendered", recipe: "Slate", repaired: true });
		expect(savedDiagramSummary(fallback)).toEqual({ type: "sequence", status: "fallback" });
	});

	test("words without a fence are kept as the words, and a bare diagram has none", () => {
		expect(proseAroundDiagram("Just the explanation.")).toBe("Just the explanation.");
		expect(proseAroundDiagram("flowchart TD\n  A --> B")).toBe("");
		expect(canonicalDiagramText("Just the explanation.", valid)).toBe(`Just the explanation.\n\n${fenceDiagram(SOURCE)}`);
	});
});

describe("the diagram card", () => {
	let restore: () => void;
	beforeAll(() => {
		restore = installDomGlobals();
	});
	afterAll(() => restore());

	function host(result: DrawResult): DiagramPreviewHost & { drawn: string[] } {
		const drawn: string[] = [];
		return {
			drawn,
			draw: (target, source) => {
				drawn.push(source);
				if (result === "drawn") {
					target.createEl("div", { cls: "fake-svg" });
				}
				return Promise.resolve(result);
			}
		};
	}

	function actions() {
		const log: string[] = [];
		const handlers: DiagramCardActions = {
			onInsert: () => log.push("insert"),
			onNewNote: () => log.push("note"),
			onCopy: () => log.push("copy"),
			onFix: () => log.push("fix"),
			onAnotherLook: () => log.push("look")
		};
		return { log, handlers };
	}

	function draw(info: DiagramRunResult, drawing: DrawResult, hasNote = true): { parent: HTMLElement; handle: DiagramCardHandle; log: string[]; preview: ReturnType<typeof host> } {
		const parent = createFakeEl();
		const { log, handlers } = actions();
		const preview = host(drawing);
		const copy = describeDiagramCard(info, { hasNote });
		const handle = renderDiagramCard(parent, { status: diagramCardStatus(info), copy, source: info.source, hasNote }, handlers, preview);
		return { parent, handle, log, preview };
	}

	const labels = (parent: HTMLElement): string[] => Array.from(parent.querySelectorAll(".askmate-diagram-actions button"), (button) => button.textContent ?? "");

	test("a drawn diagram shows the preview and the five actions that fit it", async () => {
		const { parent, handle, preview, log } = draw(valid, "drawn");
		await handle.ready;
		expect(preview.drawn).toEqual([SOURCE]);
		expect(parent.querySelector(".askmate-diagram-preview .fake-svg")).not.toBeNull();
		expect(parent.querySelector(".askmate-diagram-placeholder")).toBeNull();
		expect(parent.querySelector(".askmate-diagram-title")?.textContent).toBe("Flowchart");
		expect(parent.querySelector(".askmate-diagram-meta")?.textContent).toBe("Blueprint look");
		expect(labels(parent)).toEqual(["Insert", "New note", "Copy source", "Another look"]);
		for (const button of Array.from(parent.querySelectorAll<HTMLButtonElement>(".askmate-diagram-actions button"))) {
			button.click();
		}
		expect(log).toEqual(["insert", "note", "copy", "look"]);
	});

	test("shows the drawing placeholder until the preview is ready", async () => {
		const { parent, handle } = draw(valid, "drawn");
		expect(parent.querySelector(".askmate-diagram-placeholder")?.textContent).toBe("Drawing the diagram...");
		await handle.ready;
		expect(parent.querySelector(".askmate-diagram-placeholder")).toBeNull();
	});

	test("a fallback shows the source and the reason, blocks Insert and New note, and offers Fix", async () => {
		const { parent, handle, preview, log } = draw(fallback, "drawn");
		await handle.ready;
		expect(preview.drawn).toEqual([]);
		expect(parent.querySelector(".askmate-diagram-fallback pre")?.textContent).toBe(fallback.source);
		expect(parent.querySelectorAll(".askmate-diagram-fallback li")).toHaveLength(4);
		expect(labels(parent)).toEqual(["Insert", "New note", "Copy source", "Fix", "Another look"]);
		const [insert, note, , fix] = Array.from(parent.querySelectorAll<HTMLButtonElement>(".askmate-diagram-actions button"));
		expect(insert?.disabled).toBe(true);
		expect(note?.disabled).toBe(true);
		expect(insert?.getAttribute("title")).toContain("did not draw");
		expect(fix?.disabled).toBe(false);
		fix?.click();
		insert?.click();
		expect(log).toEqual(["fix"]);
		expect(parent.querySelector(".askmate-diagram-card")?.classList.contains("is-fallback")).toBe(true);
	});

	test("with no note, only Insert is off and it says why", async () => {
		const { parent, handle } = draw(valid, "drawn", false);
		await handle.ready;
		const [insert, note] = Array.from(parent.querySelectorAll<HTMLButtonElement>(".askmate-diagram-actions button"));
		expect(insert?.disabled).toBe(true);
		expect(insert?.getAttribute("title")).toBe("Open a note to insert the diagram into it.");
		expect(note?.disabled).toBe(false);
	});

	test("when this Obsidian cannot draw, the source is shown instead and the actions still work", async () => {
		const { parent, handle } = draw(valid, "unavailable");
		await handle.ready;
		expect(parent.querySelector(".askmate-diagram-preview")).toBeNull();
		expect(parent.querySelector(".askmate-diagram-fallback")?.textContent).toContain("cannot draw a preview");
		expect(parent.querySelector(".askmate-diagram-fallback pre")?.textContent).toBe(SOURCE);
		expect(parent.querySelector<HTMLButtonElement>(".askmate-diagram-actions button")?.disabled).toBe(false);
	});

	test("setBusy turns the actions off and back on without enabling a blocked one", async () => {
		const { parent, handle } = draw(fallback, "drawn");
		await handle.ready;
		handle.setBusy(true);
		const buttons = Array.from(parent.querySelectorAll<HTMLButtonElement>(".askmate-diagram-actions button"));
		expect(buttons.every((button) => button.disabled)).toBe(true);
		handle.setBusy(false);
		expect(buttons.map((button) => button.disabled)).toEqual([true, true, false, false, false]);
	});
});
