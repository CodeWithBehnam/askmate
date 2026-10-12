import { detectKind, extractDiagramParts, findRecipe } from "../../../diagrams";
import { builtInSkillId } from "../../../skills";
import type { AskRequest, DiagramRequestMetadata } from "../../../shared/types";
import type { ChatMessageLike, SavedDiagramSummary } from "../../../threads/threadModel";
import type { LastAnswer } from "../answerActions";
import type { InsertableReply } from "./insertPlan";
import type { DiagramRunResult } from "../../../requests/runTypes";

/**
 * Pure rules for the diagram reply: what the card says, how a re-roll or a fix is requested, and what is kept in a
 * saved conversation. The card and the view only draw these results.
 */

export const MERMAID_SKILL_ID = builtInSkillId("mermaid-diagrams");
export const DEFAULT_DIAGRAM_QUESTION = "Draw a Mermaid diagram of this note.";
/** The most diagram text a fix request carries; Mermaid itself stops at 50,000 and AskMate's pipeline at 16,000. */
export const MAX_FIX_SOURCE_CHARACTERS = 6000;
export const MAX_ERROR_LINES = 4;

const KIND_LABELS: Readonly<Record<string, string>> = {
	flowchart: "Flowchart",
	sequence: "Sequence diagram",
	class: "Class diagram",
	state: "State diagram",
	er: "Entity relationship diagram",
	gantt: "Gantt chart",
	pie: "Pie chart",
	quadrant: "Quadrant chart",
	mindmap: "Mind map",
	timeline: "Timeline",
	gitGraph: "Git graph",
	sankey: "Sankey diagram",
	xychart: "XY chart",
	block: "Block diagram",
	packet: "Packet diagram",
	kanban: "Kanban board",
	architecture: "Architecture diagram",
	radar: "Radar chart",
	treemap: "Treemap",
	journey: "User journey",
	requirement: "Requirement diagram",
	c4: "C4 diagram",
	venn: "Venn diagram",
	ishikawa: "Fishbone diagram"
};

export function diagramKindLabel(kind: string): string {
	return KIND_LABELS[kind] ?? (kind.trim() ? `${kind.trim().charAt(0).toUpperCase()}${kind.trim().slice(1)} diagram` : "Diagram");
}

/** The recipe name for a style id; an unknown style (a custom name from the plugin) is shown as given. */
export function diagramStyleLabel(style: string): string {
	const recipe = findRecipe(style) ?? findRecipe(style.trim().toLowerCase().replace(/\s+/g, "-"));
	return recipe?.name ?? style;
}

export type DiagramCardStatus = "drawn" | "repaired" | "fallback";

export function diagramCardStatus(info: Pick<DiagramRunResult, "status">): DiagramCardStatus {
	return info.status === "valid" ? "drawn" : info.status === "repaired" ? "repaired" : "fallback";
}

export interface DiagramCardCopy {
	title: string;
	/** Second line under the title: the look, and whether a repair was needed. */
	meta: string;
	/** Why Insert and New note are off, or null when they work. */
	blockedReason: string | null;
	/** Plain-language reason shown for a fallback. */
	fallbackMessage: string | null;
	errors: string[];
}

export function describeDiagramCard(info: DiagramRunResult, options: { hasNote: boolean }): DiagramCardCopy {
	const status = diagramCardStatus(info);
	const errors = (info.errors ?? []).map((line) => line.trim()).filter(Boolean).slice(0, MAX_ERROR_LINES);
	const style = info.style.trim() && info.style !== "auto" ? `${diagramStyleLabel(info.style)} look` : "";
	const meta = [style, status === "repaired" ? "Repaired once" : ""].filter(Boolean).join(" · ");
	if (status === "fallback") {
		return {
			title: diagramKindLabel(info.kind),
			meta,
			blockedReason: "This diagram did not draw, so it cannot be inserted or saved. Use Fix, or copy the source.",
			fallbackMessage: "AskMate could not draw this diagram. The source is shown below so nothing is lost.",
			errors
		};
	}
	return {
		title: diagramKindLabel(info.kind),
		meta,
		blockedReason: options.hasNote ? null : "Open a note to insert the diagram into it.",
		fallbackMessage: null,
		errors
	};
}

/** The request a re-roll sends: the same question with the look counter moved on. The look cycles through the eight recipes. */
export function withDiagramMetadata(request: AskRequest, diagram: DiagramRequestMetadata): AskRequest {
	return { ...request, metadata: { ...request.metadata, diagram: { ...diagram } } };
}

/** The diagram defaults from settings: a type and a style, each possibly "auto". */
export interface DiagramDefaults {
	defaultType: string;
	defaultStyle: string;
}

export function nextLook(previous: DiagramRequestMetadata | undefined, defaults: DiagramDefaults): DiagramRequestMetadata {
	return {
		kind: previous?.kind ?? (defaults.defaultType || "auto"),
		// A look that is named in settings never changes between runs, so Another look hands the choice back to the automatic cycle.
		style: "auto",
		nonce: (previous?.nonce ?? 0) + 1
	};
}

export function firstLook(defaults: DiagramDefaults): DiagramRequestMetadata {
	return { kind: defaults.defaultType || "auto", style: defaults.defaultStyle || "auto", nonce: 0 };
}

/** The diagram as a fenced block, for the saved copy of the reply, Insert and New note. */
export function fenceDiagram(source: string): string {
	return `\`\`\`mermaid\n${source.trim()}\n\`\`\``;
}

/** The reply as it is saved, inserted or written to a note: the model's own words, then the diagram. */
export function canonicalDiagramText(text: string, info: DiagramRunResult): string {
	const prose = proseAroundDiagram(text);
	return [prose, fenceDiagram(info.source)].filter(Boolean).join("\n\n");
}

/** What the model wrote around the diagram. The card shows the diagram itself, so the body shows only this. */
export function proseAroundDiagram(text: string): string {
	const parts = extractDiagramParts(text);
	if (parts.fenced) {
		return parts.prose;
	}
	// Without a fence the text is either a bare diagram (no words around it) or only words.
	return detectKind(parts.body) === null ? text.trim() : "";
}

/**
 * The question behind Fix: the diagram text and the first lines of what went wrong. It travels as the user's request
 * (the plugin's repair turn gets the same facts), so a failed diagram can be retried without retyping anything.
 */
export function buildFixQuestion(info: DiagramRunResult): string {
	const source = info.source.length > MAX_FIX_SOURCE_CHARACTERS ? `${info.source.slice(0, MAX_FIX_SOURCE_CHARACTERS)}\n...` : info.source;
	const errors = (info.errors ?? []).map((line) => line.trim()).filter(Boolean).slice(0, MAX_ERROR_LINES);
	return [
		"Fix this Mermaid diagram so that it renders. Keep its meaning and content, and change only what is needed.",
		errors.length > 0 ? `What Mermaid reported:\n${errors.join("\n")}` : "",
		fenceDiagram(source)
	].filter(Boolean).join("\n\n");
}

/** What Insert needs to know about a diagram in a reply: whether it drew, as a fresh result or as a saved one. */
export function insertMarkFor(status: DiagramRunResult["status"] | SavedDiagramSummary["status"]): "drawn" | "fallback" {
	return status === "fallback" ? "fallback" : "drawn";
}

/**
 * The newest reply of a restored conversation, told whether it holds a diagram. The saved outcome sits on the message,
 * so it is found there; a reply with no diagram comes back as it was.
 */
export function withDiagramMark(answer: LastAnswer | null, messages: readonly ChatMessageLike[]): InsertableReply | null {
	if (!answer) {
		return null;
	}
	const reply = [...messages].reverse().find((message) => message.role === "assistant" && !message.image && message.text === answer.text);
	return reply?.diagram ? { ...answer, diagram: insertMarkFor(reply.diagram.status) } : answer;
}

/** Why a diagram that did not draw has no Insert. */
export const FALLBACK_INSERT_REASON = "This diagram did not draw, so it cannot be inserted. Copy its source, or ask for it again.";

/** The short outcome kept with a saved reply. The source stays in the reply text. */
export function savedDiagramSummary(info: DiagramRunResult): SavedDiagramSummary {
	const recipe = info.style.trim() && info.style !== "auto" ? diagramStyleLabel(info.style) : undefined;
	return {
		type: info.kind,
		status: info.status === "fallback" ? "fallback" : "rendered",
		...(recipe ? { recipe } : {}),
		...(info.status === "repaired" ? { repaired: true } : {})
	};
}
