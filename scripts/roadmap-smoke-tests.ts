#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function assertIncludes(fileName: string, contents: string, expected: string, label: string): void {
	if (!contents.includes(expected)) {
		throw new Error(`${label} missing in ${fileName}: ${expected}`);
	}
}

function assertPattern(fileName: string, contents: string, pattern: RegExp, label: string): void {
	if (!pattern.test(contents)) {
		throw new Error(`${label} missing in ${fileName}: ${pattern}`);
	}
}

function assertNotPattern(fileName: string, contents: string, pattern: RegExp, label: string): void {
	if (pattern.test(contents)) {
		throw new Error(`${label} present in ${fileName}: ${pattern}`);
	}
}

function readSourceTree(dir: string): string {
	return readdirSync(dir)
		.sort((a, b) => a.localeCompare(b))
		.map((entry) => join(dir, entry))
		.map((path) => {
			const stat = statSync(path);
			if (stat.isDirectory()) {
				return readSourceTree(path);
			}
			return path.endsWith(".ts") ? readFileSync(path, "utf8") : "";
		})
		.filter(Boolean)
		.join("\n");
}

const main = [readFileSync("main.ts", "utf8"), readSourceTree("src")].join("\n");
const styles = readFileSync("styles.css", "utf8");
const readme = readFileSync("README.md", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const providerFiles = [
	"open-ai.ts",
	"azure-open-ai.ts",
	"azure-ai.ts",
	"open-router.ts",
	"anthropic.ts",
	"google-gemini.ts",
	"open-ai-compatible.ts"
];

assertIncludes("main.ts", main, "ProviderRoleSettings", "provider role settings type");
assertIncludes("main.ts", main, "getChatProviderModelRef", "chat provider routing");
assertIncludes("main.ts", main, "getImagePlanningProviderRef", "image prompt planning routing");
assertIncludes("main.ts", main, "exportCustomWorkflowPresets", "workflow preset export");
assertIncludes("main.ts", main, "importCustomWorkflowPresets", "workflow preset import");
assertIncludes("main.ts", main, "expandWorkflowPrompt", "workflow variable expansion");
assertIncludes("main.ts", main, "confirmTruncatedContextFullApply", "Apply truncated-context safety guard");
assertIncludes("main.ts", main, "confirmTextApplyPreview", "Apply preview safety guard");
assertIncludes("main.ts", main, "ApplyApprovalMode", "Apply approval mode type");
assertIncludes("main.ts", main, "applyApprovalMode", "persisted Apply approval setting");
assertIncludes("main.ts", main, "normalizeApplyApprovalMode", "Apply approval setting migration");
assertIncludes("main.ts", main, "shouldUseDiffApproval", "Apply approval decision helper");
assertIncludes("main.ts", main, "scope === \"full-note\" || scope === \"heading-section\"", "Full approval mode high-risk scopes");
assertIncludes("main.ts", main, "recordOperationUsage", "usage tracking");
for (const providerFile of providerFiles) {
	assertIncludes(`src/providers/${providerFile}`, readFileSync(join("src", "providers", providerFile), "utf8"), "ProviderRuntime", "provider adapter runtime interface");
}
assertIncludes("src/providers/index.ts", readFileSync(join("src", "providers", "index.ts"), "utf8"), "completeProviderTextRequest", "provider adapter dispatcher");
assertIncludes("main.ts", main, "buildPromptContextContent", "context capture and budget prompt helper");
assertIncludes("main.ts", main, "ContextAttachment", "context attachment model");
assertIncludes("main.ts", main, "threadedChatEnabled", "threaded chat setting");
assertIncludes("main.ts", main, "buildThreadHistoryAttachment", "thread history context builder");
assertIncludes("main.ts", main, "additionalContextPaths", "multi-note context setting");
assertIncludes("main.ts", main, "buildAdditionalNoteAttachments", "multi-note context builder");
assertIncludes("main.ts", main, "buildFolderContextAttachments", "folder context builder");
assertIncludes("main.ts", main, "extractExcalidrawSummary", "Excalidraw summary extraction");
assertIncludes("main.ts", main, "buildImageManifestAttachments", "image manifest context builder");
assertIncludes("main.ts", main, "ApplyScope", "partial Apply scope type");
assertIncludes("main.ts", main, "TextApplyPreviewScope", "text Apply preview scope type");
assertIncludes("main.ts", main, "appendMarkdownBlockToContent", "current-note append formatter");
assertIncludes("main.ts", main, "appendResponseToCapturedNote", "current-note append Apply helper");
assertIncludes("main.ts", main, "scope: \"append\"", "append Apply preview scope");
assertIncludes("main.ts", main, "resolveApplyScope", "shared Apply scope resolver for live Apply and review queue");
assertIncludes("main.ts", main, "createAbortError", "abort error factory");
assertIncludes("main.ts", main, "isAbortError", "abort error classifier");
assertIncludes("main.ts", main, "awaitWithAbortAndTimeout", "immediate abort and timeout request race");
assertIncludes("main.ts", main, "resolveSelectionIdentity", "selection identity resolver");
assertIncludes("main.ts", main, "BuiltRetrySnapshot", "built request retry snapshot");
assertIncludes("main.ts", main, "MutationOutcome", "structured mutation outcome");
assertIncludes("main.ts", main, "throwIfNoteChangedDuringPreview", "Apply concurrent-edit safety guard");
assertIncludes("main.ts", main, "notifySideEffect", "post-mutation success notification helper");
assertIncludes("main.ts", main, "applyResponseToHeadingSection", "heading section Apply helper");
assertIncludes("main.ts", main, "joinOpenAIUrl", "OpenAI baseUrl join helper");
assertIncludes("main.ts", main, "getOpenAIBaseUrl", "OpenAI configurable baseUrl resolver");
assertIncludes("main.ts", main, "ANTHROPIC_DEFAULT_MAX_TOKENS", "Anthropic named max_tokens default");
assertIncludes("main.ts", main, "GEMINI_DEFAULT_MAX_OUTPUT_TOKENS", "Gemini named maxOutputTokens default");
assertIncludes("main.ts", main, "x-goog-api-key", "Gemini header API key auth");
assertIncludes("main.ts", main, "OpenAI text requests use the Responses API", "OpenAI dispatcher must not fall through to compatible chat");
assertIncludes("main.ts", main, "Quarantined OpenAI Responses SSE helpers", "quarantined OpenAI SSE helpers module");
assertIncludes("main.ts", main, "normalizeAskMateSettings", "unified settings normalize for load/save");
assertIncludes("main.ts", main, "UsageService", "usage service extraction");
assertIncludes("main.ts", main, "HistoryService", "history service extraction");
assertIncludes("main.ts", main, "parseMarkdownHeadingSections", "pure heading parse helper");
assertIncludes("main.ts", main, "splitMarkdownFrontmatter", "pure frontmatter split helper");
assertIncludes("main.ts", main, "registerCustomWorkflowCommands", "custom workflow command registration");
assertIncludes("main.ts", main, "Insert the generated image into", "image insert confirmation");
assertIncludes("src/usage/UsageService.ts", readFileSync(join("src", "usage", "UsageService.ts"), "utf8"), "recordOperationUsage", "usage service records operations");
assertIncludes("src/history/HistoryService.ts", readFileSync(join("src", "history", "HistoryService.ts"), "utf8"), "queueReviewItemFromRequest", "history service review queue");
assertIncludes("src/context/ContextService.ts", readFileSync(join("src", "context", "ContextService.ts"), "utf8"), "buildContextAttachments", "context service attachments");
assertIncludes("src/context/ContextService.ts", readFileSync(join("src", "context", "ContextService.ts"), "utf8"), "getNoteContext", "context service sticky note capture");
assertIncludes("src/requests/RequestRunner.ts", readFileSync(join("src", "requests", "RequestRunner.ts"), "utf8"), "runOpenAIRequest", "request runner orchestration");
assertIncludes("src/requests/requestBuilders.ts", readFileSync(join("src", "requests", "requestBuilders.ts"), "utf8"), "buildTextInstructions", "request prompt builders");
assertIncludes("main.ts", main, "contextService", "plugin wires ContextService");
assertIncludes("main.ts", main, "requestRunner", "plugin wires RequestRunner");
assertIncludes("main.ts", main, "resultNoteTemplate", "per-workflow result template support");
assertPattern("main.ts", main, /imagePromptPlanningProviderId:\s*"same-as-chat"/, "default planning provider role");
assertPattern("main.ts", main, /{{\s*response\s*}}/, "result template response variable");
assertPattern("main.ts", main, /{{\s*imageEmbed\s*}}/, "image result template embed variable");
assertIncludes("main.ts", main, "EvidenceSource", "evidence source model");
assertIncludes("main.ts", main, "openEvidenceSource", "evidence jump action");
assertIncludes("main.ts", main, "AskMateDiffConfirmModal", "Markdown diff Apply preview modal");
assertIncludes("main.ts", main, "frontmatterApplyPolicy", "frontmatter-aware Apply setting");
assertIncludes("main.ts", main, "runBatchWorkflow", "batch workflow runner");
assertIncludes("main.ts", main, "PromptInspection", "final prompt inspector model");
assertIncludes("main.ts", main, "noteHistoryStore", "note-specific AskMate history store");
assertIncludes("main.ts", main, "styleGuideContextPath", "style guide context role");
assertIncludes("main.ts", main, "glossaryContextPath", "glossary context role");
assertIncludes("main.ts", main, "ReviewQueueItem", "review queue model");
assertIncludes("main.ts", main, "smartResultPlacementEnabled", "smart result placement setting");
assertIncludes("main.ts", main, "usageGuardrailsEnabled", "usage guardrails setting");
assertIncludes("main.ts", main, "listMarkdownFilesInFolder", "folder-scoped markdown listing helper");
assertNotPattern("main.ts", main, /getMarkdownFiles\s*\(/, "vault-wide Markdown enumeration should stay absent");
assertNotPattern("main.ts", main, /navigator\.clipboard/, "direct clipboard access should stay absent");

assertIncludes("styles.css", styles, "askmate-composer-layout-expanded", "expanded composer layout styles");
assertIncludes("styles.css", styles, "askmate-onboarding-card", "onboarding styles");
assertIncludes("styles.css", styles, "askmate-focus-ring", "theme focus polish");
assertIncludes("styles.css", styles, "askmate-diff-line-added", "diff preview styles");
assertIncludes("styles.css", styles, "askmate-evidence-chip", "evidence chip styles");
assertIncludes("styles.css", styles, "askmate-prompt-inspector", "prompt inspector styles");
assertIncludes("styles.css", styles, "askmate-batch-progress", "batch progress styles");
assertIncludes("styles.css", styles, "askmate-review-item", "review queue styles");
assertIncludes("styles.css", styles, "askmate-budget-warning", "budget warning styles");
assertIncludes("styles.css", styles, "min-height: 0;\n\tmin-width: 0;\n\toverflow: hidden;", "sidebar scroll containment");
assertIncludes("styles.css", styles, "flex: 1 1 0;\n\tflex-direction: column;\n\tgap: 8px;\n\tmin-height: 0;\n\toverflow-y: auto;\n\toverscroll-behavior: contain;", "message pane scroll containment");

assertIncludes("README.md", readme, "Roadmap", "roadmap documentation");
assertIncludes("README.md", readme, "Evidence-linked", "evidence-linked answers documentation");
assertIncludes("README.md", readme, "Markdown diff Apply preview", "diff Apply documentation");
assertIncludes("README.md", readme, "Apply approval mode", "Apply approval mode documentation");
assertIncludes("README.md", readme, "`Auto approve`: skips selected-text, append, and heading-section diff previews", "auto approve documentation");
assertIncludes("README.md", readme, "`Full`: asks with a diff for full-note and heading-section replacements", "full approval documentation");
assertIncludes("README.md", readme, "`Manual`: asks with a diff before every text Apply write", "manual approval documentation");
assertIncludes("README.md", readme, "frontmatter", "frontmatter controls documentation");
assertIncludes("README.md", readme, "Batch workflow runner", "batch workflow documentation");
assertIncludes("README.md", readme, "Final prompt inspector", "prompt inspector documentation");
assertIncludes("README.md", readme, "Note-specific AskMate history", "note history documentation");
assertIncludes("README.md", readme, "Style guide and glossary", "role context documentation");
assertIncludes("README.md", readme, "Queue for review", "review queue documentation");
assertIncludes("README.md", readme, "Smart result-note placement", "smart placement documentation");
assertIncludes("README.md", readme, "Usage budgets", "usage guardrails documentation");
assertIncludes("README.md", readme, "appends generated output to the captured note", "default no-selection Apply append documentation");
assertIncludes("CONTRIBUTING.md", contributing, "Default no-selection text Apply appends", "default no-selection Apply append contributor guard");
assertIncludes("CONTRIBUTING.md", contributing, "Apply approval modes", "Apply approval mode contributor guard");
assertIncludes("README.md", readme, "Azure OpenAI", "Azure OpenAI documentation");
assertIncludes("README.md", readme, "Azure AI Foundry", "Azure AI Foundry documentation");
assertIncludes("README.md", readme, "/openai/v1", "Azure OpenAI v1 endpoint documentation");
assertIncludes("README.md", readme, "/models/chat/completions", "Azure AI Foundry inference endpoint documentation");
assertIncludes("README.md", readme, "deployment name", "Azure OpenAI deployment name documentation");
assertIncludes("README.md", readme, "gpt-image-2", "OpenAI image model documentation");
assertNotPattern("README.md", readme, /\| Azure OpenAI \| Yes \| Yes/i, "Azure OpenAI image support should stay absent");
assertNotPattern("README.md", readme, /^- \[ \]/m, "unchecked roadmap boxes should be absent");

console.log("AskMate roadmap smoke tests passed.");
