import type { Editor, TFile } from "obsidian";

export type OutputMode = "chat" | "note" | "apply";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type SendShortcut = "enter" | "ctrl-enter";
export type ContextSource = "Selected text" | "Current note";
export type ChatRole = "user" | "assistant" | "system";
export type ModelCapability = "text" | "image";
export type RequestIntentKind = "freeform_text" | "workflow" | "explicit_image" | "auto_image";
export type RequestCommandSource = "sidebar" | "command_palette";
export type OperationKind = "text_response" | "image_prompt_planning" | "image_generation";
export type OperationStatus = "completed" | "failed" | "aborted" | "fallback";
export type ApiEndpoint = "responses" | "images_generations" | "chat_completions" | "anthropic_messages" | "gemini_generate_content";
export type TextProviderId = "openai" | "azure-openai" | "azure-ai" | "openrouter" | "anthropic" | "google-gemini" | "openai-compatible";
export type ContextBudgetMode = "expanded" | "balanced" | "concise";
export type ImagePromptPlanningProviderId = TextProviderId | "same-as-chat";
export type ComposerLayout = "compact" | "expanded";
export type ContextAttachmentKind =
	| "thread_history"
	| "note_history"
	| "additional_note"
	| "folder_note"
	| "style_guide"
	| "glossary"
	| "excalidraw_summary"
	| "image_manifest";
export type ApplyScope = "auto" | "selected-block" | "heading-section" | "full-note" | "append";
/** Resolved Apply target after expanding `auto` against note/selection context. */
export type EffectiveApplyScope = Exclude<ApplyScope, "auto">;
export type ApplyApprovalMode = "auto-approve" | "full" | "manual";
export type FrontmatterApplyPolicy = "preserve" | "confirm" | "replace";
export type BatchWorkflowOutputMode = "note" | "review-queue";
export type BudgetEnforcementMode = "warn" | "block";
export type ReviewQueueStatus = "pending" | "applied" | "dismissed";
export type MarkdownDiffLineKind = "context" | "added" | "removed";

export interface ProviderSettings {
	apiKeySecretName: string;
	model: string;
	modelOptions: string[];
	baseUrl: string;
}

export type TextProviderSettings = Record<TextProviderId, ProviderSettings>;

export interface ProviderModelRef {
	providerId: TextProviderId;
	providerName: string;
	model: string;
	capability: ModelCapability;
}

export interface ProviderRoleSettings {
	chatProviderId: TextProviderId;
	imagePromptPlanningProviderId: ImagePromptPlanningProviderId;
}

export interface ProviderTextResult {
	text: string;
	model: string;
	endpoint: ApiEndpoint;
	usage: OpenAITokenUsage | null;
}

export interface AskMateHttpResponse<T> {
	status: number;
	ok: boolean;
	body: T | null;
	text: string;
}

export interface AskMateSettings {
	openAiApiKeySecretName: string;
	model: string;
	modelOptions: string[];
	selectedTextProvider: TextProviderId;
	providerRoles: ProviderRoleSettings;
	providers: TextProviderSettings;
	customWorkflows: CustomWorkflow[];
	requestPrivacyDefaults: RequestPrivacyOptions;
	contextBudgetMode: ContextBudgetMode;
	workflowDisplayPreferences: WorkflowDisplayPreference[];
	showRequestPreview: boolean;
	applyApprovalMode: ApplyApprovalMode;
	showApplyPreview: boolean;
	outputMode: OutputMode;
	reasoningEffort: ReasoningEffort;
	sendShortcut: SendShortcut;
	resultFolder: string;
	resultNoteTemplate: string;
	imageResultNoteTemplate: string;
	imageFolderTemplate: string;
	imageFileNameTemplate: string;
	translationTargetLanguage: string;
	workflowCustomInstructions: string;
	composerLayout: ComposerLayout;
	showOnboardingTips: boolean;
	onboardingTipsDismissedAt: string | null;
	threadedChatEnabled: boolean;
	threadedChatMaxTurns: number;
	additionalContextPaths: string[];
	additionalContextMaxCharacters: number;
	folderContextEnabled: boolean;
	folderContextPath: string;
	folderContextMaxFiles: number;
	folderContextMaxCharacters: number;
	includeExcalidrawSummaries: boolean;
	excalidrawSummaryMaxCharacters: number;
	includeImageManifests: boolean;
	partialApplyDefaultScope: ApplyScope;
	evidenceLinkedAnswersEnabled: boolean;
	evidenceMaxSources: number;
	frontmatterApplyPolicy: FrontmatterApplyPolicy;
	batchWorkflowFolderPath: string;
	batchWorkflowId: string;
	batchWorkflowMaxFiles: number;
	batchWorkflowOutputMode: BatchWorkflowOutputMode;
	noteHistoryEnabled: boolean;
	noteHistoryIncludeInContext: boolean;
	noteHistoryMaxTurnsPerNote: number;
	noteHistoryStore: NoteHistoryStore;
	includeStyleGuideContext: boolean;
	styleGuideContextPath: string;
	styleGuideMaxCharacters: number;
	includeGlossaryContext: boolean;
	glossaryContextPath: string;
	glossaryMaxCharacters: number;
	reviewQueue: ReviewQueueItem[];
	reviewQueueMaxItems: number;
	smartResultPlacementEnabled: boolean;
	appendResultBacklinkToSource: boolean;
	usageGuardrailsEnabled: boolean;
	usageDailyTokenBudget: number;
	usageMonthlyTokenBudget: number;
	usagePerRequestWarningTokens: number;
	usagePerRequestHardLimitTokens: number;
	usageBudgetEnforcement: BudgetEnforcementMode;
	tokenUsageStats: TokenUsageStats;
}

export interface ContextAttachment {
	kind: ContextAttachmentKind;
	title: string;
	sourcePath: string;
	content: string;
	originalCharacters: number;
	finalCharacters: number;
	truncated: boolean;
}

export interface ImageReferenceInfo {
	target: string;
	label: string;
	line: string;
}

export interface NoteContext {
	content: string;
	file: TFile | null;
	source: ContextSource;
	activeHeadingPath?: string | null;
	selectionStartLine?: number | null;
	selectionEndLine?: number | null;
	attachments?: ContextAttachment[];
}

export interface AskRequestMetadata {
	intentKind: RequestIntentKind;
	commandSource: RequestCommandSource;
	outputMode: OutputMode;
	promptVersion: string;
	providerId: TextProviderId;
	providerName: string;
	selectedModel: string;
	modelCapability: ModelCapability;
	reasoningEffort: ReasoningEffort;
	privacy: RequestPrivacyOptions;
	contextBudgetMode: ContextBudgetMode;
	contextBudgetLimitCharacters: number | null;
	contextTruncated: boolean;
	contextCharacters: number;
	promptContextCharacters: number;
	contextAttachmentCount: number;
	contextAttachmentSources: string[];
	threadHistoryIncluded: boolean;
	folderContextPath: string | null;
	folderContextFilesIncluded: number;
	evidenceEnabled: boolean;
	evidenceSourceCount: number;
	forceImage: boolean;
	autoImage: boolean;
	workflowId: string | null;
	workflowName: string | null;
	createdAt: string;
}

export interface AskRequest {
	context: NoteContext;
	question: string;
	title: string;
	metadata: AskRequestMetadata;
	evidenceSources: EvidenceSource[];
}

export interface BuildRequestOptions {
	editor?: Editor;
	file?: TFile | null;
	intentKind?: RequestIntentKind;
	commandSource?: RequestCommandSource;
	outputMode?: OutputMode;
	forceImage?: boolean;
	autoImage?: boolean;
	workflow?: Workflow;
	privacy?: Partial<RequestPrivacyOptions>;
	contextBudgetMode?: ContextBudgetMode;
	threadMessages?: ChatMessage[];
	includeThreadHistory?: boolean;
	additionalContextPaths?: string[];
	folderContext?: FolderContextOptions;
	forceFileContext?: boolean;
}

export interface RunRequestOptions {
	forceImage?: boolean;
	workflow?: Workflow;
	privacy?: RequestPrivacyOptions;
	contextBudgetMode?: ContextBudgetMode;
	outputMode?: OutputMode;
	additionalContextPaths?: string[];
	folderContext?: FolderContextOptions;
	threadMessages?: ChatMessage[];
	includeThreadHistory?: boolean;
}

export interface FolderContextOptions {
	enabled: boolean;
	path: string;
	maxFiles: number;
	maxCharacters: number;
}

export interface RetryRequestSnapshot {
	question: string;
	title: string;
	options: RunRequestOptions;
	createdAt: string;
}

export interface ActiveRun {
	id: number;
	abortController: AbortController;
	intentKind: RequestIntentKind;
	startedAt: string;
}

export interface MessageActionOptions {
	requiresIdle?: boolean;
}

export interface ImagePromptExtraction {
	prompt: string;
	fallbackReason: string | null;
}

export interface PromptContextResult {
	text: string;
	originalCharacters: number;
	finalCharacters: number;
	truncated: boolean;
	limitCharacters: number | null;
}

export interface ChatMessage {
	role: ChatRole;
	text: string;
}

export interface TextAskMateResult {
	kind: "text";
	model: string;
	text: string;
}

export interface ImageAskMateResult {
	kind: "image";
	model: string;
	image: GeneratedImage;
	promptPlan: ImagePromptPlan;
}

export type AskMateResult = TextAskMateResult | ImageAskMateResult;

export interface ImagePromptPlan {
	prompt: string;
	planningModel: string;
	status: "completed" | "fallback";
	fallbackReason: string | null;
}

export interface ChatImagePreview {
	src: string;
	label: string;
}

export interface GeneratedImage {
	mimeType: "image/png";
	base64: string;
	prompt: string;
	revisedPrompt: string | null;
	createdAt: string;
	savedImagePath: string | null;
}

export interface MessageElements {
	wrapper: HTMLElement;
	header: HTMLElement;
	actions: HTMLElement;
	body: HTMLElement;
	evidence: HTMLElement;
}

export interface OpenAIResponsePart {
	type?: string;
	text?: string;
}

export interface OpenAIResponseItem {
	content?: OpenAIResponsePart[];
}

export interface OpenAIResponseBody {
	output_text?: string;
	output?: OpenAIResponseItem[];
	usage?: OpenAITokenUsage;
	error?: {
		message?: string;
	};
}

export interface OpenAITokenUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: {
		cached_tokens?: number;
	};
	output_tokens_details?: {
		reasoning_tokens?: number;
	};
}

export interface OpenAIStreamEvent {
	type?: string;
	delta?: string;
	usage?: OpenAITokenUsage;
	response?: {
		status?: string;
		usage?: OpenAITokenUsage;
		error?: {
			message?: string;
		};
		incomplete_details?: {
			reason?: string;
		};
	};
	error?: {
		message?: string;
	};
}

export interface TokenUsageRecord {
	id: string;
	timestamp: string;
	providerId: TextProviderId;
	providerName: string;
	model: string;
	title: string;
	contextSource: ContextSource;
	sourcePath: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputTokens: number;
	reasoningOutputTokens: number;
	durationMs: number;
	estimated: boolean;
	operationKind: OperationKind;
	outputMode: OutputMode;
	promptVersion: string;
	status: OperationStatus;
	endpoint: ApiEndpoint;
	errorMessage: string;
}

export interface TokenUsageStats {
	records: TokenUsageRecord[];
}

export interface TokenUsageSummary {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputTokens: number;
	reasoningOutputTokens: number;
	estimatedRecords: number;
	completedOperations: number;
	failedOperations: number;
	abortedOperations: number;
	fallbackOperations: number;
	imageOperations: number;
	averageTotalTokens: number;
	averageDurationMs: number;
	lastRecord: TokenUsageRecord | null;
}

export interface OpenAIModelListBody {
	data?: Array<{
		id?: string;
	}>;
	error?: {
		message?: string;
	};
}

export interface GeminiModelListBody {
	models?: Array<{
		name?: string;
		supportedGenerationMethods?: string[];
	}>;
	error?: {
		message?: string;
	};
}

export interface OpenAIImageGenerationBody {
	data?: Array<{
		b64_json?: string;
		revised_prompt?: string;
	}>;
	error?: {
		message?: string;
	};
}

export type WorkflowAccent = "blue" | "violet" | "green" | "amber" | "rose" | "slate";
export type WorkflowPromptFactory = (settings: AskMateSettings) => string;
export type WorkflowPrompt = string | WorkflowPromptFactory;

export interface RequestPrivacyOptions {
	includeNoteContext: boolean;
	includeImageReferences: boolean;
}

export interface CustomWorkflow {
	id: string;
	name: string;
	shortName: string;
	description: string;
	icon: string;
	accent: WorkflowAccent;
	prompt: string;
	resultNoteTemplate: string;
	hidden: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface WorkflowDisplayPreference {
	id: string;
	favorite: boolean;
	hidden: boolean;
	order: number;
}

export interface Workflow {
	id: string;
	commandId: string;
	name: string;
	shortName: string;
	description: string;
	icon: string;
	accent: WorkflowAccent;
	prompt: WorkflowPrompt;
	resultNoteTemplate?: string;
	isCustom?: boolean;
}

export interface MarkdownHeadingSection {
	level: number;
	title: string;
	path: string;
	headingLine: number;
	bodyStartLine: number;
	endLineExclusive: number;
}

export interface EvidenceSource {
	id: string;
	kind: ContextAttachmentKind | "primary_note";
	sourcePath: string;
	title: string;
	lineStart: number;
	lineEnd: number;
	excerpt: string;
}

export interface EvidenceCitation {
	sourceId: string;
	source: EvidenceSource;
}

export interface MarkdownDiffLine {
	kind: MarkdownDiffLineKind;
	oldLineNumber: number | null;
	newLineNumber: number | null;
	text: string;
}

export interface FrontmatterBlock {
	exists: boolean;
	malformed: boolean;
	frontmatter: string;
	body: string;
	endLineExclusive: number;
}

export interface FrontmatterApplyResult {
	text: string;
	warning: string;
	cancelled: boolean;
}

export interface PromptInspection {
	request: AskRequest;
	providerName: string;
	model: string;
	capability: ModelCapability;
	instructions: string;
	input: string;
	secondaryInput: string;
	estimatedInputTokens: number;
	warnings: string[];
}

export interface NoteHistoryTurn {
	id: string;
	sourcePath: string;
	createdAt: string;
	title: string;
	question: string;
	answer: string;
	providerName: string;
	model: string;
	outputMode: OutputMode;
	intentKind: RequestIntentKind;
}

export interface NoteHistoryStore {
	turns: NoteHistoryTurn[];
}

export interface ReviewQueueItem {
	id: string;
	createdAt: string;
	updatedAt: string;
	status: ReviewQueueStatus;
	sourcePath: string;
	title: string;
	question: string;
	proposedText: string;
	beforeText: string;
	scope: ApplyScope;
	headingPath: string;
	providerName: string;
	model: string;
	workflowId: string | null;
	workflowName: string | null;
}

export interface BatchWorkflowRunOptions {
	folderPath: string;
	workflowId: string;
	maxFiles: number;
	outputMode: BatchWorkflowOutputMode;
	contextBudgetMode: ContextBudgetMode;
}

export interface BatchWorkflowProgress {
	total: number;
	completed: number;
	failed: number;
	currentPath: string;
	message: string;
}

export interface BatchWorkflowSummary {
	total: number;
	completed: number;
	failed: number;
	createdNotes: string[];
	queuedReviews: number;
}

export interface UsageGuardrailResult {
	estimatedInputTokens: number;
	dayUsedTokens: number;
	monthUsedTokens: number;
	warnings: string[];
	blockers: string[];
}
