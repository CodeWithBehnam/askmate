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

	/**
	 * Budgets read per-day totals because the record list is capped (MAX_TOKEN_USAGE_RECORDS) and would undercount
	 * a busy month. Data saved before totals existed falls back to the records.
	 */
	getUsageTotalsByDay(): Record<string, number> {
		const stats = normalizeTokenUsageStats(this.host.getSettings().tokenUsageStats);
		return stats.totalsByDay ?? buildUsageTotalsFromRecords(stats.records);
	}

	evaluateUsageGuardrails(
		_request: AskRequest,
		estimatedInputTokens?: number,
		resolveEstimatedInputTokens?: () => number
	): UsageGuardrailResult {
		const settings = this.host.getSettings();
		const estimate = estimatedInputTokens ?? resolveEstimatedInputTokens?.() ?? 0;
		const todayKey = getLocalDayKey(new Date());
		const totals = this.getUsageTotalsByDay();
		const dayUsedTokens = totals[todayKey] ?? 0;
		const monthUsedTokens = sumUsageTotalsForMonth(totals, todayKey.slice(0, 7));
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
			const isImageGeneration = endpoint === "images_generations";
			const inputUsage = getNonNegativeInteger(usage?.input_tokens);
			const outputUsage = getNonNegativeInteger(usage?.output_tokens);
			const totalUsage = getNonNegativeInteger(usage?.total_tokens);
			// Image prompts are not priced like text, so an image call without reported usage is recorded as 0 rather than a text estimate.
			const inputTokens = inputUsage ?? (isImageGeneration ? 0 : estimateTokenCount(`${instructions}\n\n${input}`));
			const outputTokens = outputUsage ?? (isImageGeneration ? 0 : estimateTokenCount(responseText));
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
				estimated: inputUsage === null || outputUsage === null || totalUsage === null,
				operationKind,
				outputMode: request.metadata.outputMode,
				promptVersion: request.metadata.promptVersion,
				status,
				endpoint,
				errorMessage: errorMessage.trim().slice(0, 240)
			};
			const stats = normalizeTokenUsageStats(settings.tokenUsageStats);
			const totalsByDay = { ...(stats.totalsByDay ?? buildUsageTotalsFromRecords(stats.records)) };
			if (countsTowardBudget(record)) {
				const dayKey = getLocalDayKey(new Date(record.timestamp));
				totalsByDay[dayKey] = (totalsByDay[dayKey] ?? 0) + record.totalTokens;
			}
			settings.tokenUsageStats = {
				records: [...stats.records, record].slice(-MAX_TOKEN_USAGE_RECORDS),
				totalsByDay
			};
			await this.host.saveSettings();
		} catch (error) {
			console.warn("AskMate could not save token usage statistics.", error);
		}
	}

	async resetTokenUsageStats(): Promise<void> {
		this.host.getSettings().tokenUsageStats = { records: [], totalsByDay: {} };
		await this.host.saveSettings();
	}
}

/** Local calendar day, because budgets reset at the user's midnight. */
export function getLocalDayKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** A failed or stopped call with no reported usage consumed nothing that can be measured, so it does not spend budget. */
export function countsTowardBudget(record: TokenUsageRecord): boolean {
	return !(record.estimated && (record.status === "failed" || record.status === "aborted"));
}

export function buildUsageTotalsFromRecords(records: TokenUsageRecord[]): Record<string, number> {
	return records
		.filter(countsTowardBudget)
		.reduce<Record<string, number>>((totals, record) => {
			const dayKey = getLocalDayKey(new Date(record.timestamp));
			return { ...totals, [dayKey]: (totals[dayKey] ?? 0) + record.totalTokens };
		}, {});
}

export function sumUsageTotalsForMonth(totals: Record<string, number>, monthKey: string): number {
	return Object.entries(totals)
		.filter(([day]) => day.startsWith(`${monthKey}-`))
		.reduce((sum, [, total]) => sum + total, 0);
}
