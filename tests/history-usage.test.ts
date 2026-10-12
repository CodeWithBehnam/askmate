import { describe, expect, test } from "bun:test";
import { HistoryService } from "../src/history/HistoryService";
import {
	buildUsageTotalsFromRecords,
	countsTowardBudget,
	evaluateHardInputLimit,
	getLocalDayKey,
	HARD_INPUT_CONFIRM_TOKENS,
	sumUsageTotalsForMonth,
	UsageService,
	type RecordOperationUsageParams
} from "../src/usage/UsageService";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import type { AskMateSettings, AskRequest, NoteHistoryTurn, ReviewQueueItem, TokenUsageRecord } from "../src/shared/types";

function createSettings(overrides: Partial<AskMateSettings> = {}): AskMateSettings {
	return { ...structuredClone(normalizeAskMateSettings({}, "load")), ...overrides };
}

function createRequest(path: string, overrides: Partial<AskRequest["metadata"]> = {}): AskRequest {
	const settings = createSettings();
	return {
		context: {
			source: "Current note",
			content: "Note body",
			file: { path, extension: "md" },
			attachments: []
		},
		question: "Rewrite this",
		title: "Rewrite",
		evidenceSources: [],
		metadata: {
			intentKind: "workflow",
			commandSource: "sidebar",
			outputMode: "apply",
			promptVersion: "test",
			providerId: "openai",
			providerName: "OpenAI",
			selectedModel: "gpt-5.5",
			modelCapability: "text",
			reasoningEffort: "medium",
			privacy: settings.requestPrivacyDefaults,
			contextBudgetMode: "expanded",
			contextBudgetLimitCharacters: null,
			contextTruncated: false,
			contextCharacters: 9,
			promptContextCharacters: 9,
			contextAttachmentCount: 0,
			contextAttachmentSources: [],
			threadHistoryIncluded: false,
			folderContextPath: null,
			folderContextFilesIncluded: 0,
			evidenceEnabled: false,
			evidenceSourceCount: 0,
			forceImage: false,
			autoImage: false,
			workflowId: null,
			workflowName: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			...overrides
		}
	} as unknown as AskRequest;
}

function pendingItem(id: string, sourcePath: string, minute: number): ReviewQueueItem {
	const createdAt = new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
	return {
		id, createdAt, updatedAt: createdAt, status: "pending", sourcePath, title: "t", question: "q", proposedText: "p", beforeText: "b",
		scope: "full-note", headingPath: "", selectionIdentity: null, providerName: "OpenAI", model: "gpt-5.5", workflowId: null, workflowName: null
	};
}

function createHistory(settings: AskMateSettings): { service: HistoryService; saves: () => number } {
	let saveCount = 0;
	const service = new HistoryService({
		getSettings: () => settings,
		saveSettings: async () => { saveCount += 1; },
		readFileText: async () => "Note body"
	});
	return { service, saves: () => saveCount };
}

describe("HistoryService review queue", () => {
	test("refuses to queue when pending items reach the limit", async () => {
		const settings = createSettings({ reviewQueueMaxItems: 2, reviewQueue: [pendingItem("a", "A.md", 1), pendingItem("b", "B.md", 2)] });
		const { service } = createHistory(settings);
		await expect(service.queueReviewItemFromRequest(createRequest("Note.md"), "proposal", "gpt-5.5", "full-note"))
			.rejects.toThrow("The review queue already has 2 pending items (limit 2)");
		expect(settings.reviewQueue).toHaveLength(2);
	});

	test("refuses to queue an incomplete reply as a replacement but allows append", async () => {
		const settings = createSettings();
		const { service } = createHistory(settings);
		const request = createRequest("Note.md", { outputIncompleteReason: "max_output_tokens" });
		await expect(service.queueReviewItemFromRequest(request, "proposal", "gpt-5.5", "full-note")).rejects.toThrow("incomplete");
		await expect(service.queueReviewItemFromRequest(request, "proposal", "gpt-5.5", "append")).resolves.toMatchObject({ scope: "append" });
	});

	test("refuses to queue a replacement when the model never saw the note, but allows append", async () => {
		const settings = createSettings();
		const { service } = createHistory(settings);
		const request = createRequest("Note.md", { privacy: { includeNoteContext: false, includeImageReferences: true } });
		await expect(service.queueReviewItemFromRequest(request, "proposal", "gpt-5.5", "full-note")).rejects.toThrow("did not see");
		await expect(service.queueReviewItemFromRequest(request, "proposal", "gpt-5.5", "append")).resolves.toMatchObject({ scope: "append" });
	});

	test("an append item is queued for a note over the size limit and stores no note snapshot", async () => {
		const settings = createSettings();
		const service = new HistoryService({
			getSettings: () => settings,
			saveSettings: async () => {},
			readFileText: async () => "x".repeat(70_000)
		});
		const item = await service.queueReviewItemFromRequest(createRequest("Big.md"), "proposal", "gpt-5.5", "append");
		expect(item.beforeText).toBe("");
	});

	test("queues a selected-block item after the note was renamed", async () => {
		const settings = createSettings();
		const { service } = createHistory(settings);
		const request = createRequest("Renamed.md");
		request.context = {
			...request.context,
			source: "Selected text",
			selectionIdentity: { text: "Note", startOffset: 0, endOffset: 4, prefix: "", suffix: " body", sourcePath: "Old.md" }
		};
		const item = await service.queueReviewItemFromRequest(request, "proposal", "gpt-5.5", "selected-block");
		expect(item.selectionIdentity?.sourcePath).toBe("Renamed.md");
	});

	test("rename moves history and queue items, including notes inside a renamed folder", async () => {
		const settings = createSettings({
			reviewQueue: [pendingItem("a", "Folder/A.md", 1), pendingItem("b", "Other.md", 2)],
			noteHistoryStore: { turns: [{ id: "t1", sourcePath: "Folder/A.md", createdAt: "2026-01-01T00:00:00.000Z", title: "", question: "", answer: "", providerName: "", model: "", outputMode: "chat", intentKind: "freeform_text" }] }
		});
		const { service, saves } = createHistory(settings);
		await service.handleFileRenamed("Folder", "Renamed");
		expect(settings.reviewQueue.map((item) => item.sourcePath)).toEqual(["Renamed/A.md", "Other.md"]);
		expect(settings.noteHistoryStore.turns[0].sourcePath).toBe("Renamed/A.md");
		expect(saves()).toBe(1);
		await service.handleFileRenamed("Unrelated.md", "X.md");
		expect(saves()).toBe(1);
	});

	test("rename does not touch a sibling whose name only shares a prefix", async () => {
		const settings = createSettings({ reviewQueue: [pendingItem("a", "Notes 2/A.md", 1)] });
		const { service } = createHistory(settings);
		await service.handleFileRenamed("Notes", "Archive");
		expect(settings.reviewQueue[0].sourcePath).toBe("Notes 2/A.md");
	});

	test("delete drops history and queued proposals for the note", async () => {
		const settings = createSettings({ reviewQueue: [pendingItem("a", "A.md", 1), pendingItem("b", "B.md", 2)] });
		const { service } = createHistory(settings);
		await service.handleFileDeleted("A.md");
		expect(settings.reviewQueue.map((item) => item.id)).toEqual(["b"]);
	});

	test("a failed save leaves the queue as it was, so a retry queues one item (STO-05)", async () => {
		const settings = createSettings();
		let failNext = true;
		const service = new HistoryService({
			getSettings: () => settings,
			saveSettings: async () => {
				if (failNext) {
					failNext = false;
					throw new Error("disk full");
				}
			},
			readFileText: async () => "Note body"
		});
		const request = createRequest("Note.md");
		await expect(service.queueReviewItemFromRequest(request, "proposal", "gpt-5.5", "append")).rejects.toThrow("disk full");
		expect(settings.reviewQueue).toHaveLength(0);
		await service.queueReviewItemFromRequest(request, "proposal", "gpt-5.5", "append");
		expect(settings.reviewQueue).toHaveLength(1);
	});

	test("a failed save removes only its own item when the queue changed meanwhile", async () => {
		const settings = createSettings();
		const service = new HistoryService({
			getSettings: () => settings,
			saveSettings: async () => {
				// Another action queues an item while this write is under way, then the write fails.
				settings.reviewQueue = [...settings.reviewQueue, pendingItem("other", "Other.md", 5)];
				throw new Error("disk full");
			},
			readFileText: async () => "Note body"
		});
		await expect(service.queueReviewItemFromRequest(createRequest("Note.md"), "proposal", "gpt-5.5", "append")).rejects.toThrow("disk full");
		expect(settings.reviewQueue.map((item) => item.id)).toEqual(["other"]);
	});
});

function historyTurn(id: string, sourcePath: string, createdAt: string): NoteHistoryTurn {
	return { id, sourcePath, createdAt, title: "t", question: "q", answer: "a", providerName: "OpenAI", model: "gpt-5.5", outputMode: "chat", intentKind: "freeform_text" };
}

describe("HistoryService note history", () => {
	test("the global cap evicts the oldest turns by date, not the other notes' newer ones (STO-06)", async () => {
		const otherNoteTurns = Array.from({ length: 199 }, (_, index) => historyTurn(`b${index}`, "B.md", new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString()));
		const settings = createSettings({
			noteHistoryEnabled: true,
			noteHistoryStore: { turns: [historyTurn("old-a", "A.md", "2026-01-01T00:00:00.000Z"), ...otherNoteTurns] }
		});
		const { service } = createHistory(settings);
		await service.recordNoteHistoryTurn(createRequest("A.md"), "answer", "gpt-5.5");
		const kept = settings.noteHistoryStore.turns.map((turn) => turn.id);
		expect(kept).toHaveLength(200);
		expect(kept).not.toContain("old-a");
		expect(kept).toContain("b0");
		expect(settings.noteHistoryStore.turns.at(-1)?.sourcePath).toBe("A.md");
		const dates = settings.noteHistoryStore.turns.map((turn) => Date.parse(turn.createdAt));
		expect(dates).toEqual([...dates].sort((a, b) => a - b));
	});

	test("a failed save restores the note history", async () => {
		const settings = createSettings({ noteHistoryEnabled: true });
		const service = new HistoryService({
			getSettings: () => settings,
			saveSettings: async () => {
				throw new Error("disk full");
			},
			readFileText: async () => "Note body"
		});
		const warn = console.warn;
		console.warn = () => undefined;
		try {
			await service.recordNoteHistoryTurn(createRequest("A.md"), "answer", "gpt-5.5");
		} finally {
			console.warn = warn;
		}
		expect(settings.noteHistoryStore.turns).toHaveLength(0);
	});

	test("nothing is recorded while note history is off or the request has no note", async () => {
		const settings = createSettings({ noteHistoryEnabled: false });
		const { service, saves } = createHistory(settings);
		await service.recordNoteHistoryTurn(createRequest("A.md"), "answer", "gpt-5.5");
		expect(settings.noteHistoryStore.turns).toHaveLength(0);
		expect(saves()).toBe(0);
	});

	test("the per-note cap keeps the newest turns of that note", async () => {
		const settings = createSettings({ noteHistoryEnabled: true, noteHistoryMaxTurnsPerNote: 2 });
		const { service } = createHistory(settings);
		for (const answer of ["one", "two", "three"]) {
			await service.recordNoteHistoryTurn(createRequest("A.md"), answer, "gpt-5.5");
		}
		expect(settings.noteHistoryStore.turns.map((turn) => turn.answer)).toEqual(["two", "three"]);
	});
});

function usageRecord(timestamp: string, totalTokens: number, overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
	return {
		id: timestamp, timestamp, providerId: "openai", providerName: "OpenAI", model: "gpt-5.5", title: "t", contextSource: "Current note", sourcePath: "",
		inputTokens: totalTokens, outputTokens: 0, totalTokens, cachedInputTokens: 0, reasoningOutputTokens: 0, durationMs: 1, estimated: false,
		operationKind: "text_response", outputMode: "chat", promptVersion: "test", status: "completed", endpoint: "responses", errorMessage: "",
		...overrides
	};
}

/** A fixed local time, so day and month totals never depend on when the suite runs. */
const NOW = new Date(2026, 5, 15, 12, 0, 0);

function createUsage(settings: AskMateSettings): UsageService {
	return new UsageService({ getSettings: () => settings, saveSettings: async () => undefined, now: () => NOW });
}

function usageParams(overrides: Partial<RecordOperationUsageParams> = {}): RecordOperationUsageParams {
	return {
		request: createRequest("Note.md"), operationKind: "text_response", endpoint: "responses", status: "completed", model: "gpt-5.5",
		instructions: "", input: "x".repeat(4000), responseText: "", startedAt: NOW, usage: null,
		...overrides
	};
}

describe("UsageService budgets", () => {
	test("monthly use counts every day, not only the last 120 records", async () => {
		const settings = createSettings({ usageGuardrailsEnabled: true, usageMonthlyTokenBudget: 1000, usageBudgetEnforcement: "block" });
		const usage = createUsage(settings);
		const request = createRequest("Note.md");
		for (let index = 0; index < 300; index += 1) {
			await usage.recordOperationUsage({
				request, operationKind: "text_response", endpoint: "responses", status: "completed", model: "gpt-5.5",
				instructions: "", input: "", responseText: "", startedAt: new Date(),
				usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
			});
		}
		expect(settings.tokenUsageStats.records.length).toBeLessThanOrEqual(120);
		const result = usage.evaluateUsageGuardrails(request, 0);
		expect(result.dayUsedTokens).toBe(900);
		expect(result.monthUsedTokens).toBe(900);
		expect(usage.evaluateUsageGuardrails(request, 200).blockers.join(" ")).toContain("Monthly budget");
	});

	test("failed calls without reported usage do not spend budget", async () => {
		const settings = createSettings();
		const usage = new UsageService({ getSettings: () => settings, saveSettings: async () => undefined });
		await usage.recordOperationUsage({
			request: createRequest("Note.md"), operationKind: "text_response", endpoint: "responses", status: "failed", model: "gpt-5.5",
			instructions: "long instructions", input: "x".repeat(4000), responseText: "", startedAt: new Date(), usage: null
		});
		expect(usage.evaluateUsageGuardrails(createRequest("Note.md"), 0).dayUsedTokens).toBe(0);
		expect(settings.tokenUsageStats.records).toHaveLength(1);
	});

	test("image generation records reported usage instead of zero", async () => {
		const settings = createSettings();
		const usage = new UsageService({ getSettings: () => settings, saveSettings: async () => undefined });
		await usage.recordOperationUsage({
			request: createRequest("Note.md"), operationKind: "image_generation", endpoint: "images_generations", status: "completed", model: "gpt-image-2",
			instructions: "", input: "a lighthouse", responseText: "", startedAt: new Date(), usage: { input_tokens: 50, output_tokens: 4000, total_tokens: 4050 }
		});
		expect(settings.tokenUsageStats.records[0].totalTokens).toBe(4050);
		expect(settings.tokenUsageStats.records[0].estimated).toBe(false);
	});

	test("reset clears records and daily totals", async () => {
		const settings = createSettings({ tokenUsageStats: { records: [usageRecord(new Date().toISOString(), 10)], totalsByDay: { [getLocalDayKey(new Date())]: 10 } } });
		const usage = new UsageService({ getSettings: () => settings, saveSettings: async () => undefined });
		await usage.resetTokenUsageStats();
		expect(usage.evaluateUsageGuardrails(createRequest("Note.md"), 0).dayUsedTokens).toBe(0);
	});

	test("old data without daily totals falls back to the records", () => {
		const today = NOW;
		const totals = buildUsageTotalsFromRecords([
			usageRecord(today.toISOString(), 10),
			usageRecord(today.toISOString(), 99, { estimated: true, status: "aborted" })
		]);
		expect(totals[getLocalDayKey(today)]).toBe(10);
		expect(sumUsageTotalsForMonth({ "2026-01-01": 5, "2026-01-31": 6, "2026-02-01": 7 }, "2026-01")).toBe(11);
	});
});

describe("UsageService spend rules (STO-07 and STO-08)", () => {
	async function dayUsed(settings: AskMateSettings): Promise<number> {
		return createUsage(settings).evaluateUsageGuardrails(createRequest("Note.md"), 0).dayUsedTokens;
	}

	test("a stopped request that was sent spends its estimated input", async () => {
		const settings = createSettings();
		await createUsage(settings).recordOperationUsage(usageParams({ status: "aborted", sent: true }));
		const [record] = settings.tokenUsageStats.records;
		expect(record.estimated).toBe(true);
		expect(record.totalTokens).toBeGreaterThan(900);
		expect(await dayUsed(settings)).toBe(record.totalTokens);
	});

	test("a request stopped before it was sent spends nothing", async () => {
		const settings = createSettings();
		const usage = createUsage(settings);
		await usage.recordOperationUsage(usageParams({ status: "aborted", sent: false }));
		await usage.recordOperationUsage(usageParams({ status: "aborted" }));
		expect(settings.tokenUsageStats.records).toHaveLength(2);
		expect(await dayUsed(settings)).toBe(0);
	});

	test("repeated stops of a large sent request now reach the block budget", async () => {
		const settings = createSettings({ usageGuardrailsEnabled: true, usageDailyTokenBudget: 3000, usageBudgetEnforcement: "block" });
		const usage = createUsage(settings);
		for (let index = 0; index < 4; index += 1) {
			await usage.recordOperationUsage(usageParams({ status: "aborted", sent: true }));
		}
		expect(usage.evaluateUsageGuardrails(createRequest("Note.md"), 100).blockers.join(" ")).toContain("Daily budget");
	});

	test("a failed request counts only when part of the reply had arrived", async () => {
		const settings = createSettings();
		const usage = createUsage(settings);
		await usage.recordOperationUsage(usageParams({ status: "failed", sent: true, responseText: "" }));
		expect(await dayUsed(settings)).toBe(0);
		await usage.recordOperationUsage(usageParams({ status: "failed", sent: true, responseText: "A partial answer that broke off" }));
		const partial = settings.tokenUsageStats.records[1];
		expect(partial.outputTokens).toBeGreaterThan(0);
		expect(await dayUsed(settings)).toBe(partial.totalTokens);
	});

	test("text that arrived proves the request was sent, even without the flag", async () => {
		const settings = createSettings();
		await createUsage(settings).recordOperationUsage(usageParams({ status: "aborted", responseText: "Some words" }));
		expect(await dayUsed(settings)).toBe(settings.tokenUsageStats.records[0].totalTokens);
	});

	test("usage the provider reported counts whatever the status", async () => {
		const settings = createSettings();
		await createUsage(settings).recordOperationUsage(usageParams({ status: "failed", usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 } }));
		expect(await dayUsed(settings)).toBe(600);
	});

	test("components without a total are exact, so the record is not estimated and a failed call counts", async () => {
		const settings = createSettings();
		await createUsage(settings).recordOperationUsage(usageParams({ status: "failed", usage: { input_tokens: 8000, output_tokens: 1200 } }));
		const [record] = settings.tokenUsageStats.records;
		expect(record.estimated).toBe(false);
		expect(record.totalTokens).toBe(9200);
		expect(await dayUsed(settings)).toBe(9200);
	});

	test("a record stays estimated when input or output usage is missing", async () => {
		const settings = createSettings();
		const usage = createUsage(settings);
		await usage.recordOperationUsage(usageParams({ usage: { input_tokens: 10, total_tokens: 10 } }));
		await usage.recordOperationUsage(usageParams({ usage: { output_tokens: 10, total_tokens: 10 } }));
		await usage.recordOperationUsage(usageParams({ usage: null }));
		expect(settings.tokenUsageStats.records.map((record) => record.estimated)).toEqual([true, true, true]);
	});

	test("countsTowardBudget applies the rule per status", () => {
		const estimated = (status: TokenUsageRecord["status"]): TokenUsageRecord => usageRecord(NOW.toISOString(), 10, { estimated: true, status });
		expect(countsTowardBudget(estimated("completed"))).toBe(true);
		expect(countsTowardBudget(estimated("fallback"))).toBe(true);
		expect(countsTowardBudget(estimated("aborted"))).toBe(false);
		expect(countsTowardBudget(estimated("aborted"), { sent: true })).toBe(true);
		expect(countsTowardBudget(estimated("failed"), { sent: true })).toBe(false);
		expect(countsTowardBudget(estimated("failed"), { outputDelivered: true })).toBe(true);
		expect(countsTowardBudget(usageRecord(NOW.toISOString(), 10, { status: "failed" }))).toBe(true);
	});

	test("the fixed clock decides which day a call is counted against", async () => {
		const settings = createSettings();
		await createUsage(settings).recordOperationUsage(usageParams({ usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } }));
		expect(settings.tokenUsageStats.totalsByDay).toEqual({ [getLocalDayKey(NOW)]: 5 });
		expect(settings.tokenUsageStats.records[0].timestamp).toBe(NOW.toISOString());
	});
});

describe("hard input limit", () => {
	test("asks for confirmation from the threshold up, whatever the guardrail settings are", () => {
		expect(evaluateHardInputLimit(HARD_INPUT_CONFIRM_TOKENS - 1)).toEqual({ confirm: false, reason: "" });
		const over = evaluateHardInputLimit(HARD_INPUT_CONFIRM_TOKENS);
		expect(over.confirm).toBe(true);
		expect(over.reason).toContain("very large");
		expect(evaluateHardInputLimit(HARD_INPUT_CONFIRM_TOKENS * 4).confirm).toBe(true);
	});

	test("ignores estimates that are not usable numbers", () => {
		expect(evaluateHardInputLimit(Number.NaN).confirm).toBe(false);
		expect(evaluateHardInputLimit(-5).confirm).toBe(false);
		expect(evaluateHardInputLimit(Number.POSITIVE_INFINITY).confirm).toBe(false);
	});

	test("takes an explicit threshold", () => {
		expect(evaluateHardInputLimit(1000, 500).confirm).toBe(true);
		expect(evaluateHardInputLimit(400, 500).confirm).toBe(false);
	});

	test("the service uses the same fixed threshold with guardrails off", () => {
		const usage = createUsage(createSettings({ usageGuardrailsEnabled: false }));
		expect(usage.evaluateHardInputLimit(HARD_INPUT_CONFIRM_TOKENS).confirm).toBe(true);
		expect(usage.evaluateHardInputLimit(1000).confirm).toBe(false);
	});
});
