/**
 * The diagram half of a request: choosing the type and look before the model is asked, and validating what comes back.
 * The pipeline itself lives in src/diagrams; this file only decides what goes into it and what the run returns.
 * Pure apart from the injected runtime and repair turn.
 */
import {
	DIAGRAM_KINDS,
	buildDiagramBrief,
	designFromRecipe,
	findRecipe,
	runDiagramPipeline,
	type Design,
	type DiagramOutcome,
	type Kind,
	type RepairRequest,
	type SafetyCheck
} from "../diagrams";
import { parseMarkdownHeadingSections } from "../output";
import { validateMermaidSource } from "../safety";
import type { DiagramRequestMetadata } from "../shared/types";
import type { DiagramPort, DiagramRunResult, DiagramRuntime, RunPhaseEvent } from "./runTypes";

export const DIAGRAM_AUTO = "auto";
/** Skill id of the built-in diagram guidance, applied to every diagram request. */
export const MERMAID_SKILL_ID = "built-in:mermaid-diagrams";
const MAX_HEADINGS = 40;
const MAX_ERROR_LINES = 4;

/**
 * The allowlist guard in src/safety as the pipeline's safety check. One source of truth: the pipeline, the preview and the
 * write path all ask the same guard, so a diagram that is drawn can also be written.
 */
export const guardSafetyCheck: SafetyCheck = (source, options) => {
	const verdict = validateMermaidSource(source, { allowPluginHeader: options.allowPluginHeader });
	return { ok: verdict.ok, reasons: verdict.reasons.map((reason) => reason.message) };
};

export function isDiagramKind(value: string): value is Kind {
	return (DIAGRAM_KINDS as readonly string[]).includes(value);
}

export interface DiagramPlan {
	design: Design;
	/** The block that goes after the request message, never into the instructions. */
	briefText: string;
	/** Recipe id of the look. */
	style: string;
	runtime: DiagramRuntime;
}

/** Title and headings seed the look, so the same note keeps its style until "Another look" changes the nonce. */
export function planDiagram(input: { title: string; content: string; options: DiagramRequestMetadata; runtime: DiagramRuntime }): DiagramPlan {
	const headings = parseMarkdownHeadingSections(input.content).map((section) => section.title).slice(0, MAX_HEADINGS);
	const kind = isDiagramKind(input.options.kind) ? input.options.kind : undefined;
	const brief = buildDiagramBrief({ title: input.title, headings, nonce: input.options.nonce, supported: input.runtime.supported, ...(kind ? { kind } : {}) });
	const chosen = input.options.style === DIAGRAM_AUTO ? undefined : findRecipe(input.options.style);
	if (!chosen || chosen.id === brief.recipe.id) {
		return { design: brief.design, briefText: brief.text, style: brief.recipe.id, runtime: input.runtime };
	}
	// The brief names the seeded recipe on its "Look:" line. Swapping that line keeps the text and the design in step.
	const seeded = `Look: ${brief.recipe.name}. ${brief.recipe.description}`;
	return {
		design: designFromRecipe(chosen, brief.seed),
		briefText: brief.text.replace(seeded, `Look: ${chosen.name}. ${chosen.description}`),
		style: chosen.id,
		runtime: input.runtime
	};
}

export function withDiagramBrief(input: string, plan: DiagramPlan | null): string {
	return plan ? `${input}\n\n${plan.briefText}` : input;
}

/** A fence one backtick longer than any run inside, so the source can never close its own block. */
function fenceFor(source: string): string {
	const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
	return "`".repeat(Math.max(3, longest + 1));
}

function fenced(source: string): string {
	const fence = fenceFor(source);
	return `${fence}mermaid\n${source.trim()}\n${fence}`;
}

/**
 * What a diagram run made of the model's reply. A reply with no diagram in it is an ordinary answer: the model may
 * decline a thin note, or answer a question that only mentions a diagram. It is shown as written and blocks nothing.
 */
export type DiagramFinish =
	| {
		kind: "diagram";
		/** The reply to show and save: the validated diagram, or the best source with a note, then the model's own sentences. */
		text: string;
		result: DiagramRunResult;
		/** True when the diagram failed validation. Apply, Insert and Save as note stay blocked for the reply. */
		blocked: boolean;
	}
	| { kind: "prose"; text: string };

export interface FinishDiagramDeps {
	plan: DiagramPlan;
	raw: string;
	port: DiagramPort;
	signal?: AbortSignal;
	requestRepair?: (request: RepairRequest) => Promise<string>;
	onPhase?: (phase: RunPhaseEvent) => void;
}

function describeOutcome(outcome: DiagramOutcome, plan: DiagramPlan, raw: string): DiagramFinish {
	if (outcome.status === "valid") {
		const repaired = outcome.repairs.length > 0 || outcome.modelRepairs > 0;
		return {
			kind: "diagram",
			text: [fenced(outcome.source), outcome.prose.trim()].filter(Boolean).join("\n\n"),
			result: { status: repaired ? "repaired" : "valid", kind: outcome.kind, style: plan.style, source: outcome.source },
			blocked: false
		};
	}
	if (outcome.stage === "no-diagram") {
		return { kind: "prose", text: raw };
	}
	const lines = outcome.message.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, MAX_ERROR_LINES);
	return {
		kind: "diagram",
		// A failed attempt with no source at all (the pipeline itself broke) keeps the model's own answer visible.
		text: outcome.body ? [fenced(outcome.body), outcome.prose.trim()].filter(Boolean).join("\n\n") : raw,
		result: { status: "fallback", kind: outcome.kind ?? "unknown", style: plan.style, source: outcome.body, errors: lines.length > 0 ? lines : [outcome.message] },
		blocked: true
	};
}

export async function finishDiagram(deps: FinishDiagramDeps): Promise<DiagramFinish> {
	deps.onPhase?.("drawing-diagram");
	const { plan } = deps;
	const requestRepair = deps.requestRepair
		? async (request: RepairRequest): Promise<string> => {
			deps.onPhase?.("repairing-diagram");
			return await deps.requestRepair!(request);
		}
		: undefined;
	const outcome = await runDiagramPipeline({
		api: plan.runtime.api,
		raw: deps.raw,
		safety: deps.port.checkSafety,
		scratch: deps.port.createScratch(),
		design: plan.design,
		supported: plan.runtime.supported,
		...(requestRepair ? { requestRepair } : {}),
		...(deps.signal ? { signal: deps.signal } : {})
	});
	return describeOutcome(outcome, plan, deps.raw);
}
