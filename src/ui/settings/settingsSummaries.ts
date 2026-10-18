import { DEFAULT_PROVIDER_SETTINGS } from "../../settings/constants";
import { formatTokenCount, getProviderLabel, normalizeProviderRoleSettings } from "../../settings/normalize";
import type { ApplyApprovalMode, AskMateSettings, ComposerLayout, OutputMode, ProviderSettings, TextProviderId } from "../../shared/types";
import { ASSUME_SECRET_PRESENT, listSetupIssues, type SecretPredicate } from "../../setup/setupState";

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

/**
 * What is missing before the chat provider can answer, worded by the shared setup rules so this page agrees with the
 * sidebar and the provider list. `hasSecret` asks the secret store whether a saved key name has a value on this device;
 * without it a saved name is taken to have one.
 */
export function summarizeProviderSetup(settings: AskMateSettings, hasSecret: SecretPredicate = ASSUME_SECRET_PRESENT): ProviderSetupSummary {
	const { providerId, model } = resolveChatProvider(settings);
	const label = getProviderLabel(providerId);
	const issues = listSetupIssues(providerId, settings, hasSecret).map((issue) => issue.message);

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
// Follow-up history and evidence-linked answers are left out: both are on by default on a fresh install, and neither adds
// material the user picked (earlier turns come from the conversation, citations only label the context already sent).
export function summarizeContextSources(settings: AskMateSettings): string {
	const enabledSources = [
		settings.additionalContextPaths.length > 0,
		settings.folderContextEnabled && settings.folderContextPath.trim() !== "",
		settings.includeExcalidrawSummaries,
		settings.includeImageManifests && settings.requestPrivacyDefaults.includeImageReferences,
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

export function summarizeInstructions(settings: AskMateSettings): string {
	const rules = settings.folderInstructions.length;
	const parts = [
		settings.globalInstructions.trim() ? "Instructions set" : null,
		rules > 0 ? pluralise(rules, "folder rule") : null
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(", ") : "Not set";
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

// ---------------------------------------------------------------------------------------------------------------------
// The six pages
// ---------------------------------------------------------------------------------------------------------------------

export type SettingsPageId = "connection" | "sidebar-output" | "privacy-memory" | "skills-tools" | "instructions" | "advanced";

export interface SettingsPageInfo {
	id: SettingsPageId;
	/** Names the page and heads it. It never contains the plugin name or the word "settings". */
	name: string;
	/** One sentence, shown on the entry. */
	desc: string;
}

/** Pages in the order they are listed. A new user needs only the first one. */
export const SETTINGS_PAGES: readonly SettingsPageInfo[] = [
	{ id: "connection", name: "Connection", desc: "Choose a provider, add your API key, and check that it works." },
	{ id: "sidebar-output", name: "Sidebar and output", desc: "How the sidebar looks, where answers go, and when notes change." },
	{ id: "privacy-memory", name: "Privacy and memory", desc: "What is sent with each question and what is kept on this device." },
	{ id: "skills-tools", name: "Skills and tools", desc: "Reusable instructions, diagram defaults, and tool servers." },
	{ id: "instructions", name: "Instructions", desc: "Tell AskMate how to answer you, with optional rules for folders." },
	{ id: "advanced", name: "Advanced", desc: "Context sources, templates, workflows, batch runs, and usage limits." }
];

export function getSettingsPage(id: SettingsPageId): SettingsPageInfo {
	const page = SETTINGS_PAGES.find((candidate) => candidate.id === id);
	if (!page) {
		throw new Error(`AskMate has no settings page named "${id}".`);
	}
	return page;
}

/** The sentence at the top of the Advanced page. */
export const ADVANCED_REASSURANCE = "You do not need anything here to use AskMate.";

function parseVersion(value: string | null | undefined): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec((value ?? "").trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative when `left` is older than `right`, zero when equal, positive when newer. Null when either is not a version. */
export function compareVersions(left: string | null | undefined, right: string | null | undefined): number | null {
	const a = parseVersion(left);
	const b = parseVersion(right);
	if (!a || !b) {
		return null;
	}
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Page entries gained displayValue and status in Obsidian 1.13.1, and AskMate still runs on 1.13.0. */
export const PAGE_SUMMARY_MIN_VERSION = "1.13.1";

/** True when this Obsidian shows a page's value and warning on its entry. An unknown version counts as no. */
export function supportsPageSummaries(apiVersion: string | null | undefined): boolean {
	const order = compareVersions(apiVersion, PAGE_SUMMARY_MIN_VERSION);
	return order !== null && order >= 0;
}

export interface PageSummaryFields {
	desc: string;
	displayValue?: () => string;
	status?: () => SettingsPageStatus;
}

/**
 * The fields of a page entry that show a live summary. A new enough Obsidian gets `displayValue` and `status`; an older one
 * ignores both silently, so the summary is folded into the description instead and the warning is spelt out in words.
 */
export function pageSummaryFields(
	supported: boolean,
	desc: string,
	summary: (() => string) | null,
	status: (() => SettingsPageStatus) | null = null
): PageSummaryFields {
	if (summary === null) {
		return { desc };
	}
	if (supported) {
		return { desc, displayValue: summary, ...(status ? { status } : {}) };
	}
	const current = summary().trim();
	// A summary that already says what is wrong ("setup needed", "2 need review", "over budget") needs no second warning.
	const alreadySaid = /setup needed|needs? (?:setup|review|attention)|over budget/i.test(current);
	const warning = status?.() === "warning" && !alreadySaid ? " Needs attention." : "";
	return { desc: current ? `${desc} Now: ${current}.${warning}` : desc };
}

export function summarizeSidebarOutput(settings: AskMateSettings, pendingReviewCount: number): string {
	const parts = [
		`${COMPOSER_LAYOUT_LABELS[settings.composerLayout]} layout`,
		OUTPUT_MODE_LABELS[settings.outputMode],
		pendingReviewCount > 0 ? pluralise(pendingReviewCount, "pending review") : null
	].filter((part): part is string => part !== null);
	return parts.join(" · ");
}

export function summarizePrivacyMemory(settings: AskMateSettings): string {
	return [
		settings.requestPrivacyDefaults.includeNoteContext ? "Note sent" : "Note not sent",
		settings.saveConversations ? "Conversations saved" : "Conversations not saved"
	].join(" · ");
}

export interface SkillsAndToolsInput {
	skillsEnabled: boolean;
	skills: { total: number; needsReview: number; invalid: number };
	mcpEnabled: boolean;
	servers: { total: number; ready: number; attention: number };
}

export function summarizeSkillsAndTools(input: SkillsAndToolsInput): { displayValue: string; status: SettingsPageStatus } {
	const skills = !input.skillsEnabled
		? "Skills off"
		: [
			pluralise(input.skills.total, "skill"),
			input.skills.needsReview > 0 ? `${input.skills.needsReview.toLocaleString("en-GB")} need review` : null
		].filter((part): part is string => part !== null).join(", ");
	const tools = !input.mcpEnabled
		? "Tools off"
		: input.servers.total === 0
			? "No servers"
			: `${pluralise(input.servers.total, "server")}${input.servers.attention > 0 ? `, ${input.servers.attention.toLocaleString("en-GB")} need attention` : ""}`;
	const needsAttention = (input.skillsEnabled && input.skills.needsReview > 0) || (input.mcpEnabled && input.servers.attention > 0);
	return { displayValue: `${skills} · ${tools}`, status: needsAttention ? "warning" : null };
}
