import type { ContextBudgetMode, DiagramSettings, McpSettings, ProviderRoleSettings, ReasoningEffort, RequestPrivacyOptions, SendShortcut, SkillMatchingMode, SkillsSettings, TextProviderId, TextProviderSettings, WorkflowAccent } from "../shared/types";

export const ASKMATE_VIEW_TYPE = "askmate-sidebar-view";
/** Id of the brand icon registered with addIcon, used for the ribbon, the view and the assistant avatar. */
export const ASKMATE_ICON_ID = "askmate";

/**
 * Schema version this build writes into data.json. A stored value above it means a newer build saved the file, so unknown
 * keys are carried through untouched instead of being treated as junk.
 */
export const CURRENT_SETTINGS_VERSION = 1;
/**
 * Setting names that older or hand-edited files used to hold an API key in plain text. They are dropped on load and save.
 * This is deliberately an explicit list: any other unknown key is kept, so a newer build's data is never deleted.
 */
export const LEGACY_SECRET_KEYS: readonly string[] = [
	"openAiApiKey",
	"openaiApiKey",
	"apiKey",
	"anthropicApiKey",
	"geminiApiKey",
	"googleApiKey",
	"openRouterApiKey",
	"openrouterApiKey",
	"azureApiKey",
	"azureOpenAiApiKey",
	"localApiKey"
];

export const GPT_IMAGE_2_MODEL_ID = "gpt-image-2";
export const IMAGE_MIME_TYPE = "image/png";
export const IMAGE_FILE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
export const MAX_CONTEXT_IMAGE_PREVIEWS = 4;
export const DEFAULT_IMAGE_PROMPT = "Create a useful image inspired by the current note.";
export const IMAGE_WORKFLOW_MESSAGE = "Quick workflows create text Markdown. Use the Image button or /image command for gpt-image-2 image generation.";
export const ASKMATE_PROMPT_VERSION = "askmate-2026-10-12-prompt-standard-v4";
export const LEGACY_PROMPT_VERSION = "legacy-before-workflow-hardening";
// The built-in model lists below are suggestions. Saved lists win for OpenAI (the default list is used only when none is saved),
// while the other providers always offer their suggestions alongside whatever the user or a model refresh added.
export const DEFAULT_MODEL_OPTIONS = [
	"gpt-5.5",
	GPT_IMAGE_2_MODEL_ID
];
export const DEFAULT_OPENROUTER_MODEL_OPTIONS = [
	"openai/gpt-5.5",
	"anthropic/claude-sonnet-5.5",
	"google/gemini-2.5-pro"
];
export const DEFAULT_AZURE_OPENAI_MODEL_OPTIONS: string[] = [];
export const DEFAULT_AZURE_AI_MODEL_OPTIONS = [
	"mistral-large"
];
export const DEFAULT_ANTHROPIC_MODEL_OPTIONS = [
	"claude-sonnet-5-5",
	"claude-opus-5-5",
	"claude-haiku-4-5-20251001"
];
export interface RetiredModel {
	/** Lower-case model id or alias exactly as the API names it. */
	id: string;
	/** ISO date on which Anthropic retired the model. Requests to it fail from then on. */
	retired: string;
}
// Retired Claude models return errors, so saved settings that still name them are migrated to the default model.
// Dates come from Anthropic's model deprecations page (checked 2026-10-12). Add a model here only once its retirement date has passed:
// claude-sonnet-4-5-20250929 is deprecated but works until 2026-11-30, so it is deliberately absent.
export const RETIRED_ANTHROPIC_MODELS: readonly RetiredModel[] = [
	{ id: "claude-3-sonnet-20240229", retired: "2025-07-21" },
	{ id: "claude-3-5-sonnet-20240620", retired: "2025-10-28" },
	{ id: "claude-3-5-sonnet-20241022", retired: "2025-10-28" },
	{ id: "claude-3-5-sonnet-latest", retired: "2025-10-28" },
	{ id: "claude-3-opus-20240229", retired: "2026-01-05" },
	{ id: "claude-3-opus-latest", retired: "2026-01-05" },
	{ id: "claude-3-5-haiku-20241022", retired: "2026-02-19" },
	{ id: "claude-3-5-haiku-latest", retired: "2026-02-19" },
	{ id: "claude-3-7-sonnet-20250219", retired: "2026-02-19" },
	{ id: "claude-3-7-sonnet-latest", retired: "2026-02-19" },
	{ id: "claude-3-haiku-20240307", retired: "2026-04-20" },
	{ id: "claude-sonnet-4-20250514", retired: "2026-06-15" },
	{ id: "claude-sonnet-4-0", retired: "2026-06-15" },
	{ id: "claude-opus-4-20250514", retired: "2026-06-15" },
	{ id: "claude-opus-4-0", retired: "2026-06-15" },
	{ id: "claude-opus-4-1-20250805", retired: "2026-08-05" },
	{ id: "claude-opus-4-1", retired: "2026-08-05" }
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
		model: "claude-sonnet-5-5",
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
export const DEFAULT_TRANSLATION_TARGET_LANGUAGE = "English";
export const MAX_TRANSLATION_TARGET_LANGUAGE_LENGTH = 80;
export const MAX_TOKEN_USAGE_RECORDS = 120;
export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
export const RECENT_TOKEN_BAR_RECORD_LIMIT = 14;
export const TOKEN_RUN_CHART_RECORD_LIMIT = 30;
export const RECENT_TOKEN_TABLE_RECORD_LIMIT = 8;
export const MAX_CUSTOM_WORKFLOWS = 30;
export const MAX_CUSTOM_WORKFLOW_PROMPT_LENGTH = 12000;
export const MAX_CUSTOM_WORKFLOW_NAME_LENGTH = 80;
/** A request applies at most three skills, so a workflow cannot name more. */
export const MAX_WORKFLOW_SKILL_IDS = 3;
export const DEFAULT_CUSTOM_WORKFLOW_PROMPT = "Goal: Help with the current note.";
/** Providers whose endpoint is fixed by the vendor. Custom endpoints belong to the Local or self-hosted provider, where the host is visible. */
export const FIRST_PARTY_PROVIDER_IDS: readonly TextProviderId[] = ["openai", "anthropic", "google-gemini", "openrouter"];

export const DEFAULT_SKILLS_FOLDER = "AskMate/Skills";
export const SKILL_MATCHING_MODES: readonly SkillMatchingMode[] = ["off", "suggest", "builtin-auto", "all-auto"];
export const DEFAULT_SKILL_MATCHING_MODE: SkillMatchingMode = "builtin-auto";
export const MAX_SKILL_ID_LENGTH = 100;
export const MAX_SKILL_STATE_ENTRIES = 200;
export const MAX_DIAGRAM_SLUG_LENGTH = 40;
export const DEFAULT_DIAGRAM_CHOICE = "auto";

export const MCP_APPROVAL_MODES = ["always-ask", "ask-once-per-chat", "trusted-read-only"] as const;
export const DEFAULT_MCP_APPROVAL_MODE = "always-ask";
// These match the limits src/mcp/config.ts checks when a server is used, so a definition that loads here is never rejected there
// only for its size. Settings load goes through this file; src/mcp/config.ts must not be a second normaliser on that path.
export const MAX_MCP_SERVERS = 50;
export const MAX_MCP_ARGS = 100;
export const MAX_MCP_ENV_ENTRIES = 50;
export const MAX_MCP_LABEL_LENGTH = 60;
export const MAX_MCP_SERVER_ID_LENGTH = 40;
export const MAX_MCP_COMMAND_LENGTH = 500;
export const MAX_MCP_ARGUMENT_LENGTH = 4096;
export const MAX_MCP_DISABLED_TOOLS = 500;
export const MAX_MCP_TOOL_NAME_LENGTH = 128;
export const MAX_MCP_VALUE_LENGTH = 4096;
export const MAX_MCP_URL_LENGTH = 2000;
export const MAX_SECRET_ID_LENGTH = 100;
export const MCP_TOOL_ROUNDS_BOUNDS = { min: 1, max: 12, fallback: 5 } as const;
export const MCP_OUTPUT_CHARS_BOUNDS = { min: 1000, max: 200000, fallback: 20000 } as const;
export const MCP_CALL_TIMEOUT_BOUNDS_MS = { min: 1000, max: 600000 } as const;

export const DEFAULT_SKILLS_SETTINGS: SkillsSettings = {
	enabled: true,
	folder: DEFAULT_SKILLS_FOLDER,
	matching: DEFAULT_SKILL_MATCHING_MODE,
	disabledIds: [],
	trustedHashes: {}
};
export const DEFAULT_DIAGRAM_SETTINGS: DiagramSettings = {
	enabled: true,
	defaultType: DEFAULT_DIAGRAM_CHOICE,
	defaultStyle: DEFAULT_DIAGRAM_CHOICE,
	allowRepairTurn: true
};
// Off until the user turns it on, with no servers: nothing starts or connects by default.
export const DEFAULT_MCP_SETTINGS: McpSettings = {
	enabled: false,
	servers: [],
	maxToolRoundsPerTurn: MCP_TOOL_ROUNDS_BOUNDS.fallback,
	maxOutputChars: MCP_OUTPUT_CHARS_BOUNDS.fallback
};
// Per-record token counts above this are corrupt data; capping keeps sums finite so JSON never saves them as null.
export const MAX_TOKEN_COUNT = 1_000_000_000_000;
// Daily usage totals kept for budget checks (a little over a year).
export const MAX_USAGE_TOTAL_DAYS = 400;
