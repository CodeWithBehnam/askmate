import { describe, expect, test } from "bun:test";
import type { MermaidApi, ScratchHost } from "../src/diagrams";
import type { ProviderRequestOptions, ProviderRuntime } from "../src/providers/types";
import { MERMAID_SKILL_ID, guardSafetyCheck } from "../src/requests/diagramRun";
import { RequestRunner, type RequestRunnerHost } from "../src/requests/RequestRunner";
import type { DiagramPort, RunPhaseEvent } from "../src/requests/runTypes";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import type { AskMateHttpResponse, AskMateSettings, NoteContext, ProviderModelRef, Workflow } from "../src/shared/types";

type UsageParams = Parameters<RequestRunnerHost["recordOperationUsage"]>[0];

const GOOD = "```mermaid\nflowchart TD\n  A[Start] --> B[Finish]\n```\nShows: two steps.";
const BROKEN = "```mermaid\nflowchart TD\n  A[Start] --> BROKEN(\n```";
const FIXED = "```mermaid\nflowchart TD\n  A[Start] --> B[Finish]\n```";

function answer(text: string): AskMateHttpResponse<unknown> {
	const body = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 } };
	return { status: 200, ok: true, body, text: JSON.stringify(body) };
}

const REF: ProviderModelRef = { providerId: "openai", providerName: "OpenAI", model: "gpt-5.5", capability: "text" };

function noteContext(content: string): NoteContext {
	return { content, file: null, source: "Current note", attachments: [] };
}

interface Options {
	replies: AskMateHttpResponse<unknown>[];
	allowRepair?: boolean;
	canSendRepair?: boolean;
	diagramsEnabled?: boolean;
	mermaid?: boolean;
}

function createRig(options: Options) {
	const queue = [...options.replies];
	const bodies: Array<Record<string, unknown>> = [];
	const records: UsageParams[] = [];
	const settings: AskMateSettings = { ...DEFAULT_SETTINGS };
	const runtime: ProviderRuntime = {
		getProviderSettings: () => ({ apiKeySecretName: "", model: "gpt-5.5", modelOptions: [], baseUrl: "https://example.test/v1" }),
		getProviderApiKey: () => Promise.resolve("sk-test"),
		requestJson: <T,>(_url: string, request?: ProviderRequestOptions): Promise<AskMateHttpResponse<T>> => {
			bodies.push(JSON.parse(request?.body ?? "{}") as Record<string, unknown>);
			const next = queue.shift();
			return next ? Promise.resolve(next as AskMateHttpResponse<T>) : Promise.reject(new Error("Unexpected provider request"));
		}
	};
	const api: MermaidApi = {
		parse: (text) => (text.includes("BROKEN") ? Promise.reject(new Error("Parse error on line 3: unexpected token")) : Promise.resolve({ diagramType: "flowchart-v2" })),
		render: (id) => Promise.resolve({ svg: `<svg id="${id}"></svg>` })
	};
	const scratch: ScratchHost = { open: () => ({ container: {} as Element, close: () => undefined }) };
	const diagrams: DiagramPort = {
		isEnabled: () => options.diagramsEnabled ?? true,
		allowRepairTurn: () => options.allowRepair ?? true,
		getRuntime: () => Promise.resolve(options.mermaid === false ? null : { api, supported: ["flowchart", "sequence", "mindmap"] }),
		createScratch: () => scratch,
		checkSafety: guardSafetyCheck,
		canSendRepair: () => options.canSendRepair ?? true
	};
	const host: RequestRunnerHost = {
		getSettings: () => settings,
		getProviderRuntime: () => runtime,
		getOpenAiApiKey: () => Promise.resolve("sk-test"),
		getSelectedProviderModelRef: () => REF,
		getSelectedReasoningEffort: () => "medium",
		getImagePlanningProviderRef: () => REF,
		getImagePlanningModel: () => "gpt-5.5",
		shouldGenerateImageFromQuestion: (question) => /\bpicture\b/i.test(question),
		recordOperationUsage: (params) => {
			records.push(params);
			return Promise.resolve();
		},
		getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
		expandWorkflowPrompt: () => "",
		getNoteContext: () => Promise.resolve(noteContext("# Release process\n\nWe branch, test and ship.\n\n## Checks\n\nRun the suite.")),
		getFileNoteContext: () => Promise.resolve(noteContext("Note.")),
		getFullNoteContext: () => Promise.resolve(noteContext("Note.")),
		buildContextAttachments: () => Promise.resolve([]),
		extensions: {
			diagrams,
			skills: {
				resolve: (input) => ({
					skills: (input.workflow ?? []).includes(MERMAID_SKILL_ID)
						? [{ id: MERMAID_SKILL_ID, name: "mermaid-diagrams", source: "built-in", version: "1", hash: "h", body: "Pick the diagram type from the content.", activation: "workflow", characters: 40 }]
						: [],
					notices: [],
					suggestion: null,
					totalCharacters: 0
				})
			}
		},
		throwIfAborted: (signal) => {
			if (signal?.aborted) {
				throw new DOMException("stopped", "AbortError");
			}
		}
	};
	return { runner: new RequestRunner(host), bodies, records };
}

describe("diagram requests", () => {
	test("diagram wording is a diagram request, never an image request", async () => {
		const { runner } = createRig({ replies: [] });
		expect(runner.classifyRequestIntent("Draw a flowchart of the release process")).toBe("diagram");
		expect(runner.classifyRequestIntent("Draw a picture of a cat")).toBe("auto_image");
		expect(runner.classifyRequestIntent("What does this note say?")).toBe("freeform_text");
	});

	test("with diagrams switched off, diagram wording is an ordinary question", async () => {
		const { runner } = createRig({ replies: [], diagramsEnabled: false });
		expect(runner.classifyRequestIntent("Draw a flowchart of the release process")).toBe("freeform_text");
	});

	test("a valid diagram carries the diagram skill, the design brief, the plugin header and a valid result", async () => {
		const { runner, bodies, records } = createRig({ replies: [answer(GOOD)] });
		const request = await runner.buildRequest("Draw a flowchart of the release process", "Diagram");
		expect(request.metadata.intentKind).toBe("diagram");
		expect(request.skills?.map((skill) => skill.id)).toEqual([MERMAID_SKILL_ID]);
		expect(request.metadata.diagram).toEqual({ kind: "auto", style: "auto", nonce: 0 });
		// A diagram has no citations, because a source ID would sit inside the syntax.
		expect(request.evidenceSources).toEqual([]);

		const phases: RunPhaseEvent[] = [];
		const result = await runner.runOpenAIRequest(request, { onPhase: (phase) => phases.push(phase) });

		expect(result.kind === "text" ? result.diagram?.status : "").toBe("valid");
		expect(result.kind === "text" ? result.diagram?.kind : "").toBe("flowchart");
		expect(result.kind === "text" ? result.diagram?.source : "").toContain("flowchart TD");
		expect(result.kind === "text" ? result.text : "").toMatch(/^```mermaid\n---\nconfig:/);
		expect(result.kind === "text" ? result.text : "").toContain("Shows: two steps.");
		expect(result.kind === "text" ? result.skillsUsed?.map((skill) => skill.channel) : []).toEqual(["workflow"]);
		expect(runner.getRunFacts(request)).toMatchObject({ diagramValid: true, diagramBlocked: false });
		expect(phases).toContain("drawing-diagram");
		// The brief goes with the request message, and the skill goes with the instructions.
		expect(String(bodies[0]?.input)).toContain("<diagram_brief>");
		expect(String(bodies[0]?.instructions)).toContain("Pick the diagram type from the content.");
		expect(String(bodies[0]?.instructions)).not.toContain("diagram_brief");
		expect(records.map((record) => record.operationKind)).toEqual(["text_response"]);
	});

	test("one repair turn fixes a diagram that does not parse, is recorded as its own operation and does not stream", async () => {
		const { runner, bodies, records } = createRig({ replies: [answer(BROKEN), answer(FIXED)] });
		const request = await runner.buildRequest("Draw a flowchart of the release process", "Diagram");
		const phases: RunPhaseEvent[] = [];
		const deltas: string[] = [];
		const result = await runner.runOpenAIRequest(request, { onPhase: (phase) => phases.push(phase), onTextDelta: (delta) => deltas.push(delta) });

		expect(result.kind === "text" ? result.diagram?.status : "").toBe("repaired");
		expect(records.map((record) => record.operationKind)).toEqual(["text_response", "diagram_repair"]);
		expect(phases).toEqual(["drawing-diagram", "repairing-diagram"]);
		// The repair turn is a second request with only the error lines and the failing source, not the note.
		expect(bodies).toHaveLength(2);
		expect(String(bodies[1]?.input)).toContain("<diagram_error");
		expect(String(bodies[1]?.input)).not.toContain("We branch, test and ship.");
		// Only the first answer was shown while it arrived.
		expect(deltas.join("")).toBe(BROKEN);
	});

	test("a repair that the usage guardrails block leaves a fallback and blocks writing", async () => {
		const { runner, bodies } = createRig({ replies: [answer(BROKEN)], canSendRepair: false });
		const request = await runner.buildRequest("Draw a flowchart of the release process", "Diagram");
		const result = await runner.runOpenAIRequest(request);

		expect(bodies).toHaveLength(1);
		expect(result.kind === "text" ? result.diagram?.status : "").toBe("fallback");
		expect(result.kind === "text" ? result.diagram?.errors?.join(" ") : "").toMatch(/guardrails|Parse error/);
		expect(runner.getRunFacts(request)).toMatchObject({ diagramBlocked: true, diagramValid: false });
	});

	test("with the repair setting off, a broken diagram is not sent to the model again", async () => {
		const { runner, bodies } = createRig({ replies: [answer(BROKEN)], allowRepair: false });
		const request = await runner.buildRequest("Draw a flowchart of the release process", "Diagram");
		const result = await runner.runOpenAIRequest(request);

		expect(bodies).toHaveLength(1);
		expect(result.kind === "text" ? result.diagram?.status : "").toBe("fallback");
		expect(runner.getRunFacts(request).diagramBlocked).toBe(true);
	});

	test("a diagram that fails again after its repair is a fallback, with the best source shown", async () => {
		const { runner, records } = createRig({ replies: [answer(BROKEN), answer(BROKEN)] });
		const request = await runner.buildRequest("Draw a flowchart of the release process", "Diagram");
		const result = await runner.runOpenAIRequest(request);

		expect(result.kind === "text" ? result.diagram?.status : "").toBe("fallback");
		expect(result.kind === "text" ? result.text : "").toContain("BROKEN(");
		expect(records.map((record) => record.operationKind)).toEqual(["text_response", "diagram_repair"]);
	});

	test("the Mermaid workflow gets the same brief and checks without being reclassified", async () => {
		const { runner, bodies } = createRig({ replies: [answer(GOOD)] });
		const workflow = { id: "mermaid-diagram", name: "Mermaid diagram", prompt: "Draw the note.", skillIds: [MERMAID_SKILL_ID], outputKind: "new-content" } as unknown as Workflow;
		const request = await runner.buildRequest("Draw the note.", "Mermaid diagram", { workflow });
		expect(request.metadata.intentKind).toBe("workflow");
		expect(request.metadata.diagram).toEqual({ kind: "auto", style: "auto", nonce: 0 });

		const result = await runner.runOpenAIRequest(request);

		expect(result.kind === "text" ? result.diagram?.status : "").toBe("valid");
		expect(String(bodies[0]?.input)).toContain("<diagram_brief>");
	});

	test("running the same request again starts from nothing: an earlier failure no longer blocks it", async () => {
		const { runner } = createRig({ replies: [answer(BROKEN), answer(GOOD)], allowRepair: false });
		const request = await runner.buildRequest("Draw a flowchart of the release process", "Diagram");

		await runner.runOpenAIRequest(request);
		expect(runner.getRunFacts(request).diagramBlocked).toBe(true);
		const second = await runner.runOpenAIRequest(request);

		expect(second.kind === "text" ? second.diagram?.status : "").toBe("valid");
		expect(runner.getRunFacts(request)).toMatchObject({ diagramBlocked: false, diagramValid: true });
	});

	test("without Mermaid the answer is returned as written, with no diagram result", async () => {
		const { runner } = createRig({ replies: [answer(GOOD)], mermaid: false });
		const request = await runner.buildRequest("Draw a flowchart of the release process", "Diagram");
		const result = await runner.runOpenAIRequest(request);

		expect(result.kind === "text" ? result.text : "").toBe(GOOD);
		expect(result.kind === "text" ? result.diagram : "x").toBeUndefined();
		expect(runner.getRunFacts(request).diagramBlocked).toBe(false);
	});

	test("Another look changes the look and a chosen style is used", async () => {
		const { runner, bodies } = createRig({ replies: [answer(GOOD), answer(GOOD)] });
		const first = await runner.buildRequest("Draw a flowchart of the release process", "Diagram", { diagram: { nonce: 0 } });
		const second = await runner.buildRequest("Draw a flowchart of the release process", "Diagram", { diagram: { nonce: 1, style: "terminal" } });
		await runner.runOpenAIRequest(first);
		const result = await runner.runOpenAIRequest(second);

		expect(second.metadata.diagram).toEqual({ kind: "auto", style: "terminal", nonce: 1 });
		expect(result.kind === "text" ? result.diagram?.style : "").toBe("terminal");
		// The brief names the look it asks for, in step with the design the plugin builds.
		expect(String(bodies[1]?.input)).toContain("Look: Terminal");
		expect(String(bodies[0]?.input)).not.toContain("Look: Terminal");
	});
});
