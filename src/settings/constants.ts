import type { ContextBudgetMode, ProviderRoleSettings, ReasoningEffort, RequestPrivacyOptions, SendShortcut, TextProviderId, TextProviderSettings, WorkflowAccent } from "../shared/types";

export const ASKMATE_VIEW_TYPE = "askmate-sidebar-view";

export const GPT_IMAGE_2_MODEL_ID = "gpt-image-2";
export const IMAGE_MIME_TYPE = "image/png";
export const IMAGE_FILE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
export const MAX_CONTEXT_IMAGE_PREVIEWS = 4;
export const DEFAULT_IMAGE_PROMPT = "Create a useful image inspired by the current note.";
export const IMAGE_WORKFLOW_MESSAGE = "Quick workflows create text Markdown. Use the Image button or /image command for gpt-image-2 image generation.";
export const ASKMATE_PROMPT_VERSION = "askmate-2026-05-11-workflow-hardening-v1";
export const LEGACY_PROMPT_VERSION = "legacy-before-workflow-hardening";
export const OPENAI_MODEL_REQUEST_TIMEOUT_MS = 10000;
export const DEFAULT_MODEL_OPTIONS = [
	"gpt-5.5",
	GPT_IMAGE_2_MODEL_ID
];
export const DEFAULT_OPENROUTER_MODEL_OPTIONS = [
	"openai/gpt-5.5",
	"anthropic/claude-3.5-sonnet",
	"google/gemini-2.5-pro"
];
export const DEFAULT_AZURE_OPENAI_MODEL_OPTIONS: string[] = [];
export const DEFAULT_AZURE_AI_MODEL_OPTIONS = [
	"mistral-large"
];
export const DEFAULT_ANTHROPIC_MODEL_OPTIONS = [
	"claude-3-5-sonnet-latest",
	"claude-3-5-haiku-latest"
];
export const DEFAULT_GEMINI_MODEL_OPTIONS = [
	"gemini-2.5-pro",
	"gemini-2.5-flash"
];
export const DEFAULT_LOCAL_MODEL_OPTIONS = [
	"llama3.1",
	"mistral",
	"qwen2.5"
];
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";
export const TEXT_PROVIDER_IDS: TextProviderId[] = ["openai", "azure-openai", "azure-ai", "openrouter", "anthropic", "google-gemini", "openai-compatible"];
export const TEXT_PROVIDER_LABELS: Record<TextProviderId, string> = {
	openai: "OpenAI",
	"azure-openai": "Azure OpenAI",
	"azure-ai": "Azure AI Foundry",
	openrouter: "OpenRouter",
	anthropic: "Anthropic Claude",
	"google-gemini": "Google Gemini",
	"openai-compatible": "Local or self-hosted"
};
export const DEFAULT_PROVIDER_SETTINGS: TextProviderSettings = {
	openai: {
		apiKeySecretName: "",
		model: "gpt-5.5",
		modelOptions: DEFAULT_MODEL_OPTIONS,
		baseUrl: "https://api.openai.com/v1"
	},
	"azure-openai": {
		apiKeySecretName: "",
		model: "",
		modelOptions: DEFAULT_AZURE_OPENAI_MODEL_OPTIONS,
		baseUrl: ""
	},
	"azure-ai": {
		apiKeySecretName: "",
		model: "mistral-large",
		modelOptions: DEFAULT_AZURE_AI_MODEL_OPTIONS,
		baseUrl: ""
	},
	openrouter: {
		apiKeySecretName: "",
		model: "openai/gpt-5.5",
		modelOptions: DEFAULT_OPENROUTER_MODEL_OPTIONS,
		baseUrl: "https://openrouter.ai/api/v1"
	},
	anthropic: {
		apiKeySecretName: "",
		model: "claude-3-5-sonnet-latest",
		modelOptions: DEFAULT_ANTHROPIC_MODEL_OPTIONS,
		baseUrl: "https://api.anthropic.com/v1"
	},
	"google-gemini": {
		apiKeySecretName: "",
		model: "gemini-2.5-pro",
		modelOptions: DEFAULT_GEMINI_MODEL_OPTIONS,
		baseUrl: "https://generativelanguage.googleapis.com/v1beta"
	},
	"openai-compatible": {
		apiKeySecretName: "",
		model: "llama3.1",
		modelOptions: DEFAULT_LOCAL_MODEL_OPTIONS,
		baseUrl: DEFAULT_LOCAL_BASE_URL
	}
};
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";
export const DEFAULT_SEND_SHORTCUT: SendShortcut = "enter";
export const DEFAULT_REQUEST_PRIVACY_OPTIONS: RequestPrivacyOptions = {
	includeNoteContext: true,
	includeImageReferences: true
};
export const DEFAULT_PROVIDER_ROLE_SETTINGS: ProviderRoleSettings = {
	chatProviderId: "openai",
	imagePromptPlanningProviderId: "same-as-chat"
};
export const DEFAULT_RESULT_NOTE_TEMPLATE = [
	"# {{title}}",
	"",
	"Source: {{sourceLink}}",
	"Context used: {{contextSource}}",
	"Provider: {{providerName}}",
	"Model: {{model}}",
	"Prompt version: {{promptVersion}}",
	"Intent: {{intent}}",
	"Output mode: {{outputMode}}",
	"{{workflowLine}}",
	"",
	"## Request",
	"",
	"{{request}}",
	"",
	"## Response",
	"",
	"{{response}}",
	""
].join("\n");
export const DEFAULT_IMAGE_RESULT_NOTE_TEMPLATE = [
	"# {{title}}",
	"",
	"Source: {{sourceLink}}",
	"Context used: {{contextSource}}",
	"Provider: OpenAI",
	"Model: {{model}}",
	"Planning model: {{planningModel}}",
	"Planning status: {{planningStatus}}",
	"{{planningFallbackLine}}",
	"Prompt version: {{promptVersion}}",
	"Intent: {{intent}}",
	"Output mode: {{outputMode}}",
	"{{workflowLine}}",
	"",
	"## Request",
	"",
	"{{request}}",
	"",
	"## Image",
	"",
	"{{imageEmbed}}",
	"",
	"## Image prompt used",
	"",
	"{{imagePrompt}}",
	"{{revisedPromptSection}}",
	""
].join("\n");
export const DEFAULT_IMAGE_FOLDER_TEMPLATE = "{{resultFolder}}/Images";
export const DEFAULT_IMAGE_FILE_NAME_TEMPLATE = "{{title}} Image";
export const MAX_TEMPLATE_LENGTH = 30000;
export const MAX_WORKFLOW_CUSTOM_INSTRUCTIONS_LENGTH = 4000;
export const DEFAULT_THREADED_CHAT_MAX_TURNS = 4;
export const DEFAULT_ADDITIONAL_CONTEXT_MAX_CHARACTERS = 20000;
export const DEFAULT_FOLDER_CONTEXT_MAX_FILES = 12;
export const DEFAULT_FOLDER_CONTEXT_MAX_CHARACTERS = 24000;
export const DEFAULT_EXCALIDRAW_SUMMARY_MAX_CHARACTERS = 12000;
export const DEFAULT_EVIDENCE_MAX_SOURCES = 80;
export const DEFAULT_BATCH_WORKFLOW_MAX_FILES = 10;
export const DEFAULT_NOTE_HISTORY_MAX_TURNS_PER_NOTE = 12;
export const DEFAULT_ROLE_CONTEXT_MAX_CHARACTERS = 8000;
export const DEFAULT_REVIEW_QUEUE_MAX_ITEMS = 50;
export const MAX_NOTE_HISTORY_TURNS = 200;
export const MAX_NOTE_HISTORY_QUESTION_CHARACTERS = 2000;
export const MAX_NOTE_HISTORY_ANSWER_CHARACTERS = 6000;
export const MAX_REVIEW_QUEUE_TEXT_CHARACTERS = 60000;
export const DEFAULT_USAGE_PER_REQUEST_WARNING_TOKENS = 12000;
export const MAX_CONTEXT_PATHS = 40;
export const MAX_CONTEXT_PATH_LENGTH = 240;
export const CONTEXT_BUDGET_OPTIONS: Array<{
	value: ContextBudgetMode;
	label: string;
	maxCharacters: number | null;
}> = [
	{ value: "expanded", label: "Expanded", maxCharacters: null },
	{ value: "balanced", label: "Balanced", maxCharacters: 24000 },
	{ value: "concise", label: "Concise", maxCharacters: 8000 }
];
export const WORKFLOW_ACCENTS: WorkflowAccent[] = ["blue", "violet", "green", "amber", "rose", "slate"];
export const REASONING_EFFORT_OPTIONS: Array<{
	value: ReasoningEffort;
	label: string;
	description: string;
}> = [
	{ value: "none", label: "None", description: "Fastest responses with no extra reasoning effort." },
	{ value: "low", label: "Low", description: "Light reasoning for simple requests." },
	{ value: "medium", label: "Medium", description: "Balanced default for everyday note work." },
	{ value: "high", label: "High", description: "More reasoning for harder tasks." },
	{ value: "xhigh", label: "Extra high", description: "Maximum reasoning for complex work." }
];
export const DEFAULT_TRANSLATION_TARGET_LANGUAGE = "Persian";
export const MAX_TRANSLATION_TARGET_LANGUAGE_LENGTH = 80;
export const MAX_TOKEN_USAGE_RECORDS = 120;
export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
export const RECENT_TOKEN_BAR_RECORD_LIMIT = 14;
export const TOKEN_RUN_CHART_RECORD_LIMIT = 30;
export const RECENT_TOKEN_TABLE_RECORD_LIMIT = 8;
