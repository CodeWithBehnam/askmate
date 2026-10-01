import { DEFAULT_PROVIDER_SETTINGS } from "../../settings/constants";
import { formatTokenCount, getProviderLabel, normalizeProviderRoleSettings } from "../../settings/normalize";
import type { ApplyApprovalMode, AskMateSettings, ComposerLayout, OutputMode, ProviderSettings, TextProviderId } from "../../shared/types";

export type SettingsPageStatus = "warning" | null;

export interface ProviderSetupSummary {
	displayValue: string;
	status: SettingsPageStatus;
	issues: string[];
}

const COMPOSER_LAYOUT_LABELS: Record<ComposerLayout, string> = {
	console: "Console",
	compact: "Compact",
	expanded: "Expanded"
};

const OUTPUT_MODE_LABELS: Record<OutputMode, string> = {
	chat: "Sidebar chat",
	note: "New note",
	apply: "Apply to note"
};

const APPROVAL_MODE_LABELS: Record<ApplyApprovalMode, string> = {
	"auto-approve": "Auto approve",
	full: "Full approval",
	manual: "Manual approval"
};

// Providers where the address is user-supplied, so an empty one means setup is incomplete. Each issue names the field as the UI does.
const MISSING_ENDPOINT_ISSUES: Partial<Record<TextProviderId, string>> = {
	"azure-openai": "Set the Azure OpenAI base URL.",
	"azure-ai": "Set the Azure AI Foundry endpoint.",
	"openai-compatible": "Set the local or self-hosted base URL."
};

export function pluralise(count: number, singular: string, plural: string = `${singular}s`): string {
	return `${count.toLocaleString("en-GB")} ${count === 1 ? singular : plural}`;
}

// Mirrors AskMatePlugin.getChatProviderModelRef, so the summary names the model a request would actually use.
function resolveChatProvider(settings: AskMateSettings): { providerId: TextProviderId; provider: ProviderSettings; model: string } {
	const { chatProviderId: providerId } = normalizeProviderRoleSettings(settings.providerRoles, settings.selectedTextProvider);
	const provider = settings.providers?.[providerId] ?? DEFAULT_PROVIDER_SETTINGS[providerId];
	const model = provider.model.trim() || (providerId === "azure-openai" ? "" : DEFAULT_PROVIDER_SETTINGS[providerId].model);
	return { providerId, provider, model };
}

export function summarizeProviderSetup(settings: AskMateSettings): ProviderSetupSummary {
	const { providerId, provider, model } = resolveChatProvider(settings);
	const label = getProviderLabel(providerId);
	const endpointIssue = MISSING_ENDPOINT_ISSUES[providerId];

	const issues = [
		!provider.apiKeySecretName.trim() && providerId !== "openai-compatible" ? `Add an API key for ${label}.` : null,
		endpointIssue && !provider.baseUrl.trim() ? endpointIssue : null,
		providerId === "azure-openai" && !model ? "Enter your Azure OpenAI deployment name." : null
	].filter((issue): issue is string => issue !== null);

	const modelLabel = model || (providerId === "azure-openai" ? "no deployment" : "no model");
	return {
		// The warning icon alone is not announced by screen readers, so the text says setup is incomplete too.
		displayValue: `${label} · ${issues.length > 0 ? "setup needed" : modelLabel}`,
		status: issues.length > 0 ? "warning" : null,
		issues
	};
}

export function summarizeRequestDefaults(settings: AskMateSettings): string {
	const summary = `${COMPOSER_LAYOUT_LABELS[settings.composerLayout]} layout · ${OUTPUT_MODE_LABELS[settings.outputMode]}`;
	return settings.requestPrivacyDefaults.includeNoteContext ? summary : `${summary} · Note context off`;
}

// Counts a source only when ContextService would actually attach it, so the summary never promises context that is not sent.
export function summarizeContextSources(settings: AskMateSettings): string {
	const enabledSources = [
		settings.threadedChatEnabled,
		settings.additionalContextPaths.length > 0,
		settings.folderContextEnabled && settings.folderContextPath.trim() !== "",
		settings.includeExcalidrawSummaries,
		settings.includeImageManifests && settings.requestPrivacyDefaults.includeImageReferences,
		settings.evidenceLinkedAnswersEnabled,
		settings.noteHistoryEnabled && settings.noteHistoryIncludeInContext,
		settings.includeStyleGuideContext && settings.styleGuideContextPath.trim() !== "",
		settings.includeGlossaryContext && settings.glossaryContextPath.trim() !== ""
	].filter(Boolean).length;

	if (!settings.requestPrivacyDefaults.includeNoteContext) {
		return enabledSources === 0 ? "No note context" : `No note context · ${pluralise(enabledSources, "extra source")}`;
	}
	return enabledSources === 0 ? "Note only" : `Note + ${pluralise(enabledSources, "extra source")}`;
}

export function summarizeOutputApply(settings: AskMateSettings, pendingReviewCount: number): string {
	const approval = APPROVAL_MODE_LABELS[settings.applyApprovalMode];
	return pendingReviewCount > 0 ? `${approval} · ${pluralise(pendingReviewCount, "pending review")}` : approval;
}

export function summarizeWorkflows(settings: AskMateSettings): string {
	const count = settings.customWorkflows.length;
	return count === 0 ? "No custom workflows" : pluralise(count, "custom workflow");
}

export function summarizeUsageGuardrails(settings: AskMateSettings, todayTokens: number, monthTokens = 0): string {
	if (!settings.usageGuardrailsEnabled) {
		return "Guardrails off";
	}

	const enforcement = settings.usageBudgetEnforcement === "block" ? "Block" : "Warn";
	const budget = settings.usageDailyTokenBudget > 0 ? ` of ${formatTokenCount(settings.usageDailyTokenBudget)}` : "";
	// The page's warning icon is not announced by screen readers, so going over budget is stated in words as well.
	const overBudget = getUsageGuardrailStatus(settings, todayTokens, monthTokens) === "warning" ? " · over budget" : "";
	return `${enforcement} · ${formatTokenCount(todayTokens)}${budget} tokens today${overBudget}`;
}

export function getUsageGuardrailStatus(settings: AskMateSettings, todayTokens: number, monthTokens: number): SettingsPageStatus {
	if (!settings.usageGuardrailsEnabled) {
		return null;
	}

	const dailyExceeded = settings.usageDailyTokenBudget > 0 && todayTokens >= settings.usageDailyTokenBudget;
	const monthlyExceeded = settings.usageMonthlyTokenBudget > 0 && monthTokens >= settings.usageMonthlyTokenBudget;
	return dailyExceeded || monthlyExceeded ? "warning" : null;
}
