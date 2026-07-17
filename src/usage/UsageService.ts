import type {
	ApiEndpoint,
	AskMateSettings,
	AskRequest,
	OperationKind,
	OperationStatus,
	OpenAITokenUsage,
	TextProviderId,
	TokenUsageRecord,
	TokenUsageSummary,
	UsageGuardrailResult
} from "../shared/types";
import {
	estimateTokenCount,
	formatTokenCount,
	getNonNegativeInteger,
	getProviderLabel,
	MAX_TOKEN_USAGE_RECORDS,
	normalizeTextProviderId,
	normalizeTokenUsageStats,
	summarizeTokenUsage
} from "../shared/core";

export type UsageServiceHost = {
	getSettings: () => AskMateSettings;
	saveSettings: () => Promise<void>;
};

export class UsageService {
	constructor(private readonly host: UsageServiceHost) {}

	getTokenUsageRecords(): TokenUsageRecord[] {
		return [...normalizeTokenUsageStats(this.host.getSettings().tokenUsageStats).records];
	}

	getTokenUsageSummary(): TokenUsageSummary {
		return summarizeTokenUsage(this.getTokenUsageRecords());
	}

	getUsageTokensSince(startIso: string): number {
		const startMs = Date.parse(startIso);
		return this.getTokenUsageRecords()
			.filter((record) => Date.parse(record.timestamp) >= startMs)
			.reduce((sum, record) => sum + record.totalTokens, 0);
	}

	evaluateUsageGuardrails(
		request: AskRequest,
		estimatedInputTokens?: number,
		resolveEstimatedInputTokens?: () => number
	): UsageGuardrailResult {
		const settings = this.host.getSettings();
		const estimate = estimatedInputTokens ?? resolveEstimatedInputTokens?.() ?? 0;
		const now = new Date();
		const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
		const dayUsedTokens = this.getUsageTokensSince(dayStart);
		const monthUsedTokens = this.getUsageTokensSince(monthStart);
		const warnings: string[] = [];
		const blockers: string[] = [];
		if (!settings.usageGuardrailsEnabled) {
			return { estimatedInputTokens: estimate, dayUsedTokens, monthUsedTokens, warnings, blockers };
		}
		if (settings.usagePerRequestWarningTokens > 0 && estimate >= settings.usagePerRequestWarningTokens) {
			warnings.push(`This request is estimated at ${formatTokenCount(estimate)} input tokens.`);
		}
		if (settings.usagePerRequestHardLimitTokens > 0 && estimate >= settings.usagePerRequestHardLimitTokens) {
			blockers.push(`Request estimate exceeds the hard limit of ${formatTokenCount(settings.usagePerRequestHardLimitTokens)} tokens.`);
		}
		const addBudgetMessage = (label: string, used: number, budget: number): void => {
			if (budget <= 0 || used + estimate <= budget) {
				return;
			}
			const message = `${label} budget would exceed ${formatTokenCount(budget)} tokens. Used: ${formatTokenCount(used)}, estimate: ${formatTokenCount(estimate)}.`;
			if (settings.usageBudgetEnforcement === "block") {
				blockers.push(message);
			} else {
				warnings.push(message);
			}
		};
		addBudgetMessage("Daily", dayUsedTokens, settings.usageDailyTokenBudget);
		addBudgetMessage("Monthly", monthUsedTokens, settings.usageMonthlyTokenBudget);
		return { estimatedInputTokens: estimate, dayUsedTokens, monthUsedTokens, warnings, blockers };
	}

	async recordOperationUsage(params: {
		request: AskRequest;
		providerId?: TextProviderId;
		providerName?: string;
		operationKind: OperationKind;
		endpoint: ApiEndpoint;
		status: OperationStatus;
		model: string;
		instructions: string;
		input: string;
		responseText: string;
		usage: OpenAITokenUsage | null;
		startedAt: Date;
		errorMessage?: string;
	}): Promise<void> {
		try {
			const {
				request,
				providerId,
				providerName,
				operationKind,
				endpoint,
				status,
				model,
				instructions,
				input,
				responseText,
				usage,
				startedAt,
				errorMessage = ""
			} = params;
			const settings = this.host.getSettings();
			const inputUsage = endpoint === "images_generations" ? 0 : getNonNegativeInteger(usage?.input_tokens);
			const outputUsage = endpoint === "images_generations" ? 0 : getNonNegativeInteger(usage?.output_tokens);
			const totalUsage = endpoint === "images_generations" ? 0 : getNonNegativeInteger(usage?.total_tokens);
			const inputTokens = inputUsage ?? estimateTokenCount(`${instructions}\n\n${input}`);
			const outputTokens = outputUsage ?? estimateTokenCount(responseText);
			const componentTotal = inputTokens + outputTokens;
			const totalTokens = Math.max(totalUsage ?? componentTotal, componentTotal);
			const record: TokenUsageRecord = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				timestamp: new Date().toISOString(),
				providerId: providerId ?? normalizeTextProviderId(request.metadata.providerId),
				providerName: (providerName ?? request.metadata.providerName ?? getProviderLabel(normalizeTextProviderId(request.metadata.providerId))).trim(),
				model,
				title: request.title.trim() || "AskMate request",
				contextSource: request.context.source,
				sourcePath: request.context.file?.path ?? "",
				inputTokens,
				outputTokens,
				totalTokens,
				cachedInputTokens: getNonNegativeInteger(usage?.input_tokens_details?.cached_tokens) ?? 0,
				reasoningOutputTokens: getNonNegativeInteger(usage?.output_tokens_details?.reasoning_tokens) ?? 0,
				durationMs: Math.max(0, Date.now() - startedAt.getTime()),
				estimated: endpoint === "images_generations" || inputUsage === null || outputUsage === null || totalUsage === null,
				operationKind,
				outputMode: request.metadata.outputMode,
				promptVersion: request.metadata.promptVersion,
				status,
				endpoint,
				errorMessage: errorMessage.trim().slice(0, 240)
			};
			const records = normalizeTokenUsageStats(settings.tokenUsageStats).records;
			settings.tokenUsageStats = {
				records: [...records, record].slice(-MAX_TOKEN_USAGE_RECORDS)
			};
			await this.host.saveSettings();
		} catch (error) {
			console.warn("AskMate could not save token usage statistics.", error);
		}
	}

	async resetTokenUsageStats(): Promise<void> {
		this.host.getSettings().tokenUsageStats = { records: [] };
		await this.host.saveSettings();
	}
}
