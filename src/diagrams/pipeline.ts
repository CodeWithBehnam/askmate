// Extract, safety, parse, render, then at most one model repair turn, then a typed fallback. Pure apart from the injected services,
// and it never throws: whatever the model wrote, the caller gets a DiagramOutcome back.

import { detectKind, extractDiagramParts, splitHeader, type ExtractedDiagram } from "./extract";
import { assembleDiagram, KIND_KEYWORDS } from "./header";
import { nextRenderId } from "./ids";
import { errorText, firstLines, lineOf } from "./mermaid";
import { buildRepairPrompt } from "./prompts";
import { applyDeterministicRepairs } from "./repair";
import type {
	DiagramFallback,
	DiagramOutcome,
	DiagramValid,
	Design,
	FallbackStage,
	Kind,
	MermaidApi,
	RepairRequest,
	SafetyCheck,
	ScratchHost
} from "./types";

/** Mermaid's own maxTextSize is 50,000. A body this long is unreadable anyway, and the cap bounds the cost of every scanner below. */
export const MAX_DIAGRAM_CHARS = 16_000;

export interface DiagramDeps {
	readonly api: MermaidApi;
	/** The model's answer: usually a fenced mermaid block with a short caption around it. */
	readonly raw: string;
	readonly safety: SafetyCheck;
	readonly scratch: ScratchHost;
	/** The look to apply. Without it the body is validated exactly as written, with no plugin header. */
	readonly design?: Design;
	/** Families the host Mermaid can parse, from supportedDiagrams. Omit to skip the check. */
	readonly supported?: readonly Kind[];
	/** One repair turn. Omit to disable model repairs. Must not stream into the visible message. */
	readonly requestRepair?: (request: RepairRequest) => Promise<string>;
	readonly signal?: AbortSignal;
	/** Unique element ids for Mermaid renders. Defaults to a shared counter. */
	readonly renderId?: () => string;
}

interface Failure {
	readonly stage: FallbackStage;
	readonly message: string;
	readonly lines: readonly string[];
	readonly line?: number;
}

interface Passed {
	readonly ok: true;
	readonly kind: Kind;
	readonly diagramType: string;
	readonly body: string;
	readonly source: string;
	readonly svg: string;
	readonly repairs: readonly string[];
}

interface Failed {
	readonly ok: false;
	readonly kind: Kind | null;
	readonly body: string;
	readonly failure: Failure;
	readonly repairs: readonly string[];
	readonly repairable: boolean;
}

type Attempt = Passed | Failed;

type Validated =
	| { readonly ok: true; readonly kind: Kind; readonly diagramType: string; readonly source: string; readonly svg: string }
	| { readonly ok: false; readonly failure: Failure };

const fail = (stage: FallbackStage, message: string, lines: readonly string[] = [message], line?: number): Validated => ({
	ok: false,
	failure: { stage, message, lines, ...(line === undefined ? {} : { line }) }
});

function reasonsOf(verdict: { readonly reasons?: readonly string[] }): readonly string[] {
	return verdict.reasons !== undefined && verdict.reasons.length > 0 ? verdict.reasons : ["The diagram was rejected by the safety check."];
}

async function runSafety(deps: DiagramDeps, source: string, allowPluginHeader: boolean): Promise<Validated | null> {
	const verdict = await deps.safety(source, { allowPluginHeader });
	if (verdict.ok) return null;
	const reasons = reasonsOf(verdict);
	return fail("safety", reasons.join("; "), reasons.slice(0, 4));
}

/** Everything that needs a decision about one concrete body: header rules, safety, support, parse, render. */
async function validateBody(deps: DiagramDeps, body: string, kind: Kind | null): Promise<Validated> {
	if (deps.signal?.aborted) return fail("render", "Cancelled.");
	if (deps.design !== undefined && splitHeader(body).header !== "") {
		const reason = "The diagram header is added by AskMate, so frontmatter and %% directives are not allowed.";
		return fail("safety", reason);
	}
	const unsafe = await runSafety(deps, body, false);
	if (unsafe) return unsafe;

	if (kind === null) {
		return fail("parse", "The first line is not a supported Mermaid diagram type.");
	}
	if (deps.supported !== undefined && !deps.supported.includes(kind)) {
		const choices = deps.supported.map((name) => KIND_KEYWORDS[name]).join(", ");
		return fail("parse", `This Obsidian build cannot draw ${KIND_KEYWORDS[kind]} diagrams. Use one of: ${choices}.`);
	}

	const source = deps.design === undefined ? body : assembleDiagram(body, kind, deps.design);
	if (deps.design !== undefined) {
		const unsafeSource = await runSafety(deps, source, true);
		if (unsafeSource) return unsafeSource;
	}

	let diagramType: string;
	try {
		const parsed = await deps.api.parse(source);
		if (parsed === false) return fail("parse", "Mermaid rejected the diagram.");
		diagramType = parsed.diagramType;
	} catch (error) {
		return fail("parse", firstLines(error).join("\n"), firstLines(error), lineOf(error));
	}

	// parse alone misses gantt unknown tags, sankey cycles, C4 or requirement relations to unknown ids, block `columns 0`
	// and architecture group edges without `{group}`. Those only fail inside render.
	const handle = deps.scratch.open();
	try {
		const { svg } = await deps.api.render((deps.renderId ?? nextRenderId)(), source, handle.container);
		if (/aria-roledescription="error"/.test(svg)) return fail("render", "Mermaid drew an error diagram instead of the requested one.");
		return { ok: true, kind, diagramType, source, svg };
	} catch (error) {
		return fail("render", firstLines(error).join("\n"), firstLines(error));
	} finally {
		handle.close();
	}
}

function passed(body: string, validated: Extract<Validated, { ok: true }>, repairs: readonly string[]): Passed {
	return { ok: true, kind: validated.kind, body, repairs, diagramType: validated.diagramType, source: validated.source, svg: validated.svg };
}

function failed(kind: Kind | null, body: string, failure: Failure, repairs: readonly string[], repairable: boolean): Failed {
	return { ok: false, kind, body, failure, repairs, repairable };
}

/** One full pass over one piece of model text: extract, validate, and (only when validation failed) deterministic repairs and a second validation. */
async function attempt(deps: DiagramDeps, parts: ExtractedDiagram): Promise<Attempt> {
	const body = parts.body;
	const kind = detectKind(body);
	// Nothing in the answer claims to be a diagram, so the whole text is prose. It is never kept as a diagram body, because
	// a caller that fenced it would turn an ordinary answer into a failed drawing.
	if (!parts.taggedMermaid && (body === "" || kind === null)) {
		return failed(null, "", { stage: "no-diagram", message: "No diagram found in the answer.", lines: [] }, [], false);
	}
	if (body === "") {
		return failed(kind, body, { stage: "extract", message: "The mermaid block is empty.", lines: [] }, [], false);
	}
	if (body.length > MAX_DIAGRAM_CHARS) {
		const message = `The diagram is too large (${body.length} characters, limit ${MAX_DIAGRAM_CHARS}).`;
		return failed(kind, body, { stage: "extract", message, lines: [message] }, [], false);
	}

	const first = await validateBody(deps, body, kind);
	if (first.ok) return passed(body, first, []);
	// A safety rejection is never repaired by rewriting; only the model can drop the offending construct.
	if (first.failure.stage === "safety" || deps.signal?.aborted) return failed(kind, body, first.failure, [], true);

	const repaired = applyDeterministicRepairs(body, kind);
	if (repaired.applied.length === 0) return failed(kind, body, first.failure, [], true);
	const repairedKind = detectKind(repaired.body) ?? kind;
	const second = await validateBody(deps, repaired.body, repairedKind);
	return second.ok
		? passed(repaired.body, second, repaired.applied)
		: failed(repairedKind, repaired.body, second.failure, repaired.applied, true);
}

function toValid(done: Passed, modelRepairs: 0 | 1, prose: string): DiagramValid {
	return {
		status: "valid",
		kind: done.kind,
		diagramType: done.diagramType,
		body: done.body,
		source: done.source,
		svg: done.svg,
		repairs: done.repairs,
		modelRepairs,
		prose
	};
}

function toFallback(done: Failed, modelRepairs: 0 | 1, prose: string, override?: Pick<Failure, "stage" | "message">): DiagramFallback {
	return {
		status: "fallback",
		stage: override?.stage ?? done.failure.stage,
		message: override?.message ?? done.failure.message,
		...(done.failure.line === undefined ? {} : { line: done.failure.line }),
		kind: done.kind,
		body: done.body,
		repairs: done.repairs,
		modelRepairs,
		prose
	};
}

function buildRepairRequest(done: Failed): RepairRequest | null {
	const stage = done.failure.stage;
	if (stage !== "safety" && stage !== "parse" && stage !== "render") return null;
	const errorLines = done.failure.lines.slice(0, 4);
	const failingLine = done.failure.line === undefined ? undefined : done.body.split("\n")[done.failure.line - 1];
	const trimmedFailing = failingLine?.trim() === "" ? undefined : failingLine;
	return {
		kind: done.kind,
		stage,
		body: done.body,
		errorLines,
		...(trimmedFailing === undefined ? {} : { failingLine: trimmedFailing }),
		prompt: buildRepairPrompt({ kind: done.kind, stage, body: done.body, errorLines, ...(trimmedFailing === undefined ? {} : { failingLine: trimmedFailing }) })
	};
}

async function run(deps: DiagramDeps): Promise<DiagramOutcome> {
	const firstParts = extractDiagramParts(deps.raw);
	const first = await attempt(deps, firstParts);
	if (first.ok) return toValid(first, 0, firstParts.prose);
	if (deps.signal?.aborted) return toFallback(first, 0, firstParts.prose, { stage: "aborted", message: "Cancelled." });

	const request = first.repairable && deps.requestRepair !== undefined ? buildRepairRequest(first) : null;
	if (request === null || deps.requestRepair === undefined) return toFallback(first, 0, firstParts.prose);

	let repairedText: string;
	try {
		repairedText = await deps.requestRepair(request);
	} catch (error) {
		return toFallback(first, 0, firstParts.prose, { stage: deps.signal?.aborted ? "aborted" : "repair", message: errorText(error) });
	}
	if (deps.signal?.aborted) return toFallback(first, 0, firstParts.prose, { stage: "aborted", message: "Cancelled." });

	const secondParts = extractDiagramParts(repairedText);
	const prose = secondParts.prose !== "" ? secondParts.prose : firstParts.prose;
	const second = await attempt(deps, secondParts);
	if (second.ok) return toValid(second, 1, prose);
	// Show the best text we have: the repair turn's attempt when it produced a diagram, otherwise the first attempt.
	const producedNoDiagram = second.failure.stage === "extract" || second.failure.stage === "no-diagram";
	return producedNoDiagram ? toFallback(first, 1, prose) : toFallback(second, 1, prose);
}

/**
 * Turns a model answer into a validated diagram, or a typed fallback that shows the source and blocks Apply for that reply.
 * Services are injected so the whole flow runs against a fake Mermaid in tests.
 */
export async function runDiagramPipeline(deps: DiagramDeps): Promise<DiagramOutcome> {
	try {
		return await run(deps);
	} catch (error) {
		return {
			status: "fallback",
			stage: "internal",
			message: errorText(error),
			kind: null,
			body: "",
			repairs: [],
			modelRepairs: 0,
			prose: ""
		};
	}
}
