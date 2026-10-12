/**
 * Types for the optional features of a request run: skills, tool calls and diagrams. They are declared here and not in
 * shared/types.ts so the run API can grow without touching the settings schema. Every field is optional, so a caller that
 * predates a feature compiles and behaves as before.
 */
import type { AskMateResult, AskRequest, BuildRequestOptions, DiagramRequestMetadata, ProviderModelRef } from "../shared/types";
import type { ReasoningEffort } from "../shared/types";
import type { ResolveInput, SkillResolution } from "../skills";
import type { Kind, MermaidApi, SafetyCheck, ScratchHost } from "../diagrams";
import type { ToolCallRequest, ToolOutcome, ToolSnapshot } from "../mcp";

/** How the sidebar tells a run which skills to apply. `autoEnabled` false means nothing starts or is suggested on its own. */
export interface SkillSelection {
	explicitIds: string[];
	stickyIds: string[];
	autoEnabled: boolean;
}

export type RunPhaseEvent = "tool-calling" | "awaiting-approval" | "drawing-diagram" | "repairing-diagram";

export type ToolUiStatus = "pending-approval" | "running" | "done" | "error" | "denied";

/** One tool call as a card shows it. Updated in place by `id` as the call moves from approval to a result. */
export interface ToolUiEvent {
	id: string;
	server: string;
	tool: string;
	status: ToolUiStatus;
	argumentsJson: string;
	resultPreview?: string;
	error?: string;
}

/** What an approval card shows. The arguments are the full JSON the server will receive, never a summary. */
export interface ToolApprovalCard {
	id: string;
	server: string;
	tool: string;
	title?: string;
	description?: string;
	argumentsJson: string;
	changedSinceApproval: boolean;
	/** False when there is no conversation to scope a grant to, so "Allow for this chat" is not offered. */
	canAllowForChat?: boolean;
}

export type ToolApprovalChoice = "allow-once" | "allow-chat" | "deny";

export interface SkillUsed {
	id: string;
	name: string;
	source: "built-in" | "vault";
	/** How the skill came to be part of the run: explicit, workflow, sticky or auto. */
	channel: string;
}

export interface DiagramRunResult {
	status: "valid" | "repaired" | "fallback";
	kind: string;
	style: string;
	source: string;
	errors?: string[];
}

export interface RunOptions {
	onTextDelta?: (delta: string) => void;
	/**
	 * A tool run streams every turn, and only the last one is the answer. When a turn ends in tool calls, the text it streamed
	 * was progress, so this asks the caller to clear what it showed. A tool run streams only to a caller that passes this
	 * along with onTextDelta; without it the answer arrives in one piece when the run ends.
	 */
	onTextReset?: () => void;
	abortSignal?: AbortSignal;
	forceImage?: boolean;
	skillSelection?: SkillSelection;
	/** The user opted in to tools for this run. Tools never run unless this is true. */
	toolsEnabled?: boolean;
	onToolEvent?: (event: ToolUiEvent) => void;
	/** Shows the approval card. When it is absent, the plugin opens its own approval dialog. */
	confirmToolCall?: (card: ToolApprovalCard) => Promise<ToolApprovalChoice>;
	onPhase?: (phase: RunPhaseEvent) => void;
	/** Conversation the "Allow for this chat" choice is scoped to. Without it only "Allow once" is offered. */
	chatId?: string | null;
}

export interface RunResultExtras {
	skillsUsed?: SkillUsed[];
	toolCalls?: ToolUiEvent[];
	diagram?: DiagramRunResult;
}

export type RunResult = AskMateResult & RunResultExtras;

/** Settings of one diagram request. Missing fields fall back to the diagram defaults in settings. */
export type DiagramBuildOptions = Partial<DiagramRequestMetadata>;

/** BuildRequestOptions plus the optional inputs the run pipeline understands. */
export interface ExtendedBuildOptions extends BuildRequestOptions {
	skillSelection?: SkillSelection;
	diagram?: DiagramBuildOptions;
	/** Allow a request with no note open. Apply is then unavailable, and the reason is stated. */
	allowNoNote?: boolean;
	/** Provider and effort captured by a batch after the user confirmed it, so a later settings change cannot alter the run. */
	providerRef?: ProviderModelRef;
	reasoningEffort?: ReasoningEffort;
}

/** The part of SkillService that a request needs. */
export interface SkillResolverPort {
	resolve(input: ResolveInput): SkillResolution;
}

/** Mermaid as Obsidian ships it, with the diagram families its build can parse. Null when Obsidian offers no Mermaid. */
export interface DiagramRuntime {
	api: MermaidApi;
	supported: readonly Kind[];
}

/** What the diagram path needs from the plugin. Everything with a side effect is injected. */
export interface DiagramPort {
	isEnabled(): boolean;
	allowRepairTurn(): boolean;
	getRuntime(): Promise<DiagramRuntime | null>;
	createScratch(): ScratchHost;
	checkSafety: SafetyCheck;
	/** Re-checks the usage guardrails for the extra repair turn. False means the repair must not be sent. */
	canSendRepair(request: AskRequest, estimatedInputTokens: number): boolean;
}

/** The part of McpService a tool run needs. */
export interface ToolsPort {
	prepareRun(signal?: AbortSignal): Promise<ToolSnapshot>;
	callTool(call: ToolCallRequest, signal: AbortSignal): Promise<ToolOutcome>;
}

export interface ToolRunHost {
	getService(): ToolsPort | null;
	/** The approval dialog used when the caller of a run brings no card of its own. */
	confirmCall(card: ToolApprovalCard, signal: AbortSignal): Promise<ToolApprovalChoice>;
	/** Registers how approval cards are shown for calls made with this signal. Returns the unregister function. */
	registerApproval(signal: AbortSignal, handler: (card: ToolApprovalCard) => Promise<ToolApprovalChoice>): () => void;
	/** Shown when the user opted in but the model cannot take tools, so the answer comes without them. */
	notify?(message: string): void;
}

export interface RunnerExtensions {
	skills?: SkillResolverPort;
	diagrams?: DiagramPort;
	tools?: ToolRunHost;
}

/** Facts the plugin needs about a finished run, kept per request object. */
export interface RunFacts {
	/** The reply is a diagram that failed validation. Apply, Insert and Save as note stay blocked for it. */
	diagramBlocked: boolean;
	/** The reply is a diagram that passed validation, so the plugin-built header may be written. */
	diagramValid: boolean;
	/** The reply was written after tools ran, so Apply always shows the diff first. */
	toolDerived: boolean;
}
