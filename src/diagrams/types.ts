// Shared types for the Mermaid Diagram Studio core. No Obsidian imports: callers inject the Mermaid object from loadMermaid().

/** The slice of Mermaid that the pipeline needs. Obsidian's loadMermaid() result is narrowed to this with toMermaidApi. */
export interface MermaidApi {
	parse(text: string, options?: { readonly suppressErrors?: boolean }): Promise<false | { readonly diagramType: string }>;
	render(id: string, text: string, container?: Element): Promise<{ readonly svg: string }>;
}

/** Every diagram family AskMate can design for. The runtime probe decides which of them the host Mermaid build supports. */
export const DIAGRAM_KINDS = [
	"flowchart", "sequence", "class", "state", "er", "gantt", "pie", "quadrant", "mindmap", "timeline", "gitGraph",
	"sankey", "xychart", "block", "packet", "kanban", "architecture", "radar", "treemap", "journey", "requirement", "c4", "venn", "ishikawa"
] as const;

export type Kind = (typeof DIAGRAM_KINDS)[number];

export type Mood = "pastel" | "vivid" | "muted" | "ink";
export type Role = "primary" | "accent" | "success" | "warn" | "danger" | "muted" | "ink";
export type Look = "classic" | "handDrawn";
export type Curve = "basis" | "linear" | "cardinal" | "monotoneX" | "step";
export type Density = "compact" | "regular" | "roomy";

export interface RoleColours {
	readonly fill: string;
	readonly stroke: string;
	readonly text: string;
}

export type Palette = Readonly<Record<Role, RoleColours>> & { readonly soft: string; readonly line: string };

export interface FontSpec {
	readonly family: string;
	readonly size: string;
}

/** Everything the plugin needs to build a header for one diagram. Fully determined by a recipe and a seed. */
export interface Design {
	readonly recipeId?: string;
	readonly hue: number;
	readonly mood: Mood;
	readonly accentOffset: number;
	readonly look: Look;
	readonly font?: FontSpec;
	readonly curve?: Curve;
	readonly padding?: number;
	/** handDrawnSeed. Mermaid treats 0 as "random every render", so callers keep it at 1 or more. */
	readonly seed: number;
}

export interface StyleRecipe {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly hue: number;
	readonly mood: Mood;
	readonly accentOffset: number;
	readonly look: Look;
	readonly font?: FontSpec;
	readonly curve: Curve;
	readonly density: Density;
}

export type DiagramStage = "extract" | "safety" | "parse" | "render";

/** Lines of context handed to a repair turn. Never more than four error lines, plus the failing source line when known. */
export interface RepairRequest {
	readonly kind: Kind | null;
	readonly stage: Exclude<DiagramStage, "extract">;
	readonly body: string;
	readonly errorLines: readonly string[];
	readonly failingLine?: string;
	/** Ready to send as the model input. Built by buildRepairPrompt. */
	readonly prompt: string;
}

export interface SafetyVerdict {
	readonly ok: boolean;
	readonly reasons?: readonly string[];
}

export interface SafetyOptions {
	/** True when the source starts with the header that the plugin built itself. Model-written text is always checked with false. */
	readonly allowPluginHeader: boolean;
}

/** Structural match for the allowlist guard in src/safety: the shell adapts validateMermaidSource to this shape. */
export type SafetyCheck = (source: string, options: SafetyOptions) => SafetyVerdict | Promise<SafetyVerdict>;

export interface ScratchHandle {
	readonly container: Element;
	close(): void;
}

/** Creates the hidden container that Mermaid renders into, and removes it again. The shell owns the DOM. */
export interface ScratchHost {
	open(): ScratchHandle;
}

export interface DiagramValid {
	readonly status: "valid";
	readonly kind: Kind;
	/** Mermaid's own name for the diagram, for example flowchart-v2. */
	readonly diagramType: string;
	/** What the model wrote, after deterministic repairs. No plugin header. */
	readonly body: string;
	/** The exact text Mermaid rendered: plugin header, body and classDef lines. */
	readonly source: string;
	readonly svg: string;
	/** Names of the deterministic repairs that changed the text. */
	readonly repairs: readonly string[];
	readonly modelRepairs: 0 | 1;
	/** Text the model wrote around the diagram, such as the "Shows" and "Assumptions" lines. */
	readonly prose: string;
}

/**
 * "no-diagram" means the answer holds nothing that claims to be a diagram, for example a prose reply. It is not a failure to
 * draw, so callers show the model's own words and block nothing.
 */
export type FallbackStage = DiagramStage | "no-diagram" | "repair" | "aborted" | "internal";

export interface DiagramFallback {
	readonly status: "fallback";
	readonly stage: FallbackStage;
	readonly message: string;
	readonly line?: number;
	readonly kind: Kind | null;
	/** Best available diagram text, for the visible source block. Apply and Save as note stay blocked for this reply. */
	readonly body: string;
	readonly repairs: readonly string[];
	readonly modelRepairs: 0 | 1;
	readonly prose: string;
}

export type DiagramOutcome = DiagramValid | DiagramFallback;
