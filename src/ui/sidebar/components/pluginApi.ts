import type { AskMatePlugin } from "../../../plugin/AskMatePlugin";
import type { McpService } from "../../../mcp";
import type { MermaidApi } from "../../../diagrams";
import type { SkillService } from "../../../skills";
import type { SetupStage } from "../../../setup";
import type { AskMateResult, AskRequest, TextAskMateResult, TextProviderId } from "../../../shared/types";

/**
 * The slice of the plugin that wave 2 adds (wave2-contract.md, section 1). The sidebar reaches these members only
 * through this structural type with optional chaining, so it compiles on its own and starts using them once the
 * plugin implements them. Nothing here is a second implementation: when a member is missing, the feature that needs it
 * says so in plain words instead of guessing.
 */

export type ToolUiStatus = "pending-approval" | "running" | "done" | "error" | "denied";

export interface ToolUiEvent {
	id: string;
	server: string;
	tool: string;
	status: ToolUiStatus;
	argumentsJson: string;
	resultPreview?: string;
	error?: string;
}

export interface ToolApprovalRequest {
	id: string;
	server: string;
	tool: string;
	title?: string;
	description?: string;
	argumentsJson: string;
	changedSinceApproval: boolean;
}

export type ToolApprovalChoice = "allow-once" | "allow-chat" | "deny";

export type RunPhaseSignal = "tool-calling" | "awaiting-approval" | "drawing-diagram" | "repairing-diagram";

export interface SkillSelection {
	explicitIds: string[];
	stickyIds: string[];
	autoEnabled: boolean;
}

export interface SkillUsed {
	id: string;
	name: string;
	source: "built-in" | "vault";
	channel: string;
}

export interface DiagramResultInfo {
	status: "valid" | "repaired" | "fallback";
	kind: string;
	style: string;
	source: string;
	errors?: string[];
}

export interface Wave2RunOptions {
	onTextDelta?: (delta: string) => void;
	abortSignal?: AbortSignal;
	forceImage?: boolean;
	skillSelection?: SkillSelection;
	toolsEnabled?: boolean;
	onToolEvent?: (event: ToolUiEvent) => void;
	confirmToolCall?: (card: ToolApprovalRequest) => Promise<ToolApprovalChoice>;
	onPhase?: (phase: RunPhaseSignal) => void;
}

export interface Wave2ResultFields {
	skillsUsed?: SkillUsed[];
	toolCalls?: ToolUiEvent[];
	diagram?: DiagramResultInfo;
}

export type SidebarTextResult = TextAskMateResult & Wave2ResultFields;
export type SidebarResult = SidebarTextResult | Exclude<AskMateResult, TextAskMateResult>;

/** What a connection test reports. Mirrors ProviderConnectionTestResult without importing the provider layer. */
export interface ConnectionTestLike {
	ok: boolean;
	message: string;
	modelFound?: boolean | null;
	suggestedModel?: string | null;
}

export interface PluginWave2Api {
	skillService?: SkillService;
	mcpService?: McpService | null;
	getSetupState?: () => SetupStage;
	saveProviderApiKey?: (providerId: TextProviderId, apiKey: string) => Promise<void>;
	testProviderConnectionDetailed?: () => Promise<ConnectionTestLike>;
	openSettingsTab?: () => void;
	loadMermaidApi?: () => Promise<MermaidApi | null>;
}

/**
 * Lets a build run when no note is open. The context layer supports it; the build options type gains the field when the
 * request pipeline does, and until then the field is simply passed along.
 */
export function allowNoNote<T extends object>(options: T): T & { allowNoNote: true } {
	return { ...options, allowNoNote: true };
}

type RunFunction = (request: AskRequest, options: Wave2RunOptions) => Promise<SidebarResult>;

/**
 * Wave 2 members as the optional shape. The plugin class declares them as required once it implements them, and
 * the narrowing through `unknown` keeps this file correct both before and after that.
 */
export function wave2(plugin: AskMatePlugin): PluginWave2Api {
	return plugin as unknown as PluginWave2Api;
}

/** `runOpenAIRequest` with the wave 2 options. Older plugins ignore the options they do not know. */
export function runPluginRequest(plugin: AskMatePlugin, request: AskRequest, options: Wave2RunOptions): Promise<SidebarResult> {
	const bound: unknown = plugin.runOpenAIRequest.bind(plugin);
	return (bound as RunFunction)(request, options);
}
