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

/** Above this input estimate AskMate always asks before sending, whatever the usage guardrail settings are. */
export const HARD_INPUT_CONFIRM_TOKENS = 150_000;

export type UsageServiceHost = {
	getSettings: () => AskMateSettings;
	saveSettings: () => Promise<void>;
	/** Injected so tests can pin the day budgets are counted against. Defaults to the system clock. */
	now?: () => Date;
};

export type RecordOperationUsageParams = {
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
	/**
	 * True once the request has left the machine. A stopped request that was sent has probably been billed for its
	 * input; one stopped before sending has not. Callers that predate the flag leave it unset, which counts as not sent.
	 */
	sent?: boolean;
};

/** What the budget needs to know about a call beyond the stored record. */
export type BudgetCountContext = {
	/** The request left the machine. */
	sent?: boolean;
	/** Text of the reply had arrived when the call ended. */
	outputDelivered?: boolean;
};

export type HardInputLimitResult = {
	confirm: boolean;
	reason: string;
};

/**
 * The always-on confirmation for very large requests. It is independent of the optional usage guardrails: a huge
 * Expanded context can be sent by accident with every guardrail off.
 */
export function evaluateHardInputLimit(estimatedTokens: number, thresholdTokens: number = HARD_INPUT_CONFIRM_TOKENS): HardInputLimitResult {
	if (!Number.isFinite(estimatedTokens) || estimatedTokens < thresholdTokens) {
		return { confirm: false, reason: "" };
	}
	return {
		confirm: true,
		reason: `This request is estimated at ${formatTokenCount(Math.round(estimatedTokens))} input tokens, which is very large. It may cost a lot or be rejected by the model.`
	};
}

export class UsageService {
	constructor(private readonly host: UsageServiceHost) {}

	private now(): Date {
		return this.host.now?.() ?? new Date();
	}

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

	/** Whether to ask before sending an input of this size. Fixed threshold; see the exported evaluateHardInputLimit. */
	evaluateHardInputLimit(estimatedTokens: number): HardInputLimitResult {
		return evaluateHardInputLimit(estimatedTokens);
	}

	evaluateUsageGuardrails(
		_request: AskRequest,
		estimatedInputTokens?: number,
		resolveEstimatedInputTokens?: () => number
	): UsageGuardrailResult {
		const settings = this.host.getSettings();
		const estimate = estimatedInputTokens ?? resolveEstimatedInputTokens?.() ?? 0;
		const todayKey = getLocalDayKey(this.now());
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

	async recordOperationUsage(params: RecordOperationUsageParams): Promise<void> {
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
				errorMessage = "",
				sent = false
			} = params;
			const settings = this.host.getSettings();
			const now = this.now();
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
				id: `${now.getTime()}-${Math.random().toString(36).slice(2, 9)}`,
				timestamp: now.toISOString(),
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
				durationMs: Math.max(0, now.getTime() - startedAt.getTime()),
				// The total is derived from the components, so a provider that omits total_tokens still reports exact usage.
				estimated: inputUsage === null || outputUsage === null,
				operationKind,
				outputMode: request.metadata.outputMode,
				promptVersion: request.metadata.promptVersion,
				status,
				endpoint,
				errorMessage: errorMessage.trim().slice(0, 240)
			};
			const stats = normalizeTokenUsageStats(settings.tokenUsageStats);
			const totalsByDay = { ...(stats.totalsByDay ?? buildUsageTotalsFromRecords(stats.records)) };
			if (countsTowardBudget(record, { sent, outputDelivered: responseText.trim().length > 0 })) {
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

/**
 * Whether a call spends budget. Usage the provider reported always counts. For an estimate:
 * - a completed or fallback call counts;
 * - a stopped call counts only when the request was sent (or part of the reply had arrived), because the input has
 *   probably been billed;
 * - a failed call counts only when part of the reply had arrived, because most failures (bad key, rate limit,
 *   network) are not billed and counting them would block users during an outage.
 * Without a context, as for records read back from storage, the estimates of stopped and failed calls stay out.
 */
export function countsTowardBudget(record: TokenUsageRecord, context: BudgetCountContext = {}): boolean {
	if (!record.estimated) {
		return true;
	}
	switch (record.status) {
		case "aborted":
			// Text that arrived proves the request was sent, even for a caller that does not set the flag.
			return context.sent === true || context.outputDelivered === true;
		case "failed":
			return context.outputDelivered === true;
		case "completed":
		case "fallback":
			return true;
	}
}

export function buildUsageTotalsFromRecords(records: TokenUsageRecord[]): Record<string, number> {
	return records
		.filter((record) => countsTowardBudget(record))
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
