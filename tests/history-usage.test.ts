import { describe, expect, test } from "bun:test";
import { HistoryService } from "../src/history/HistoryService";
import { buildUsageTotalsFromRecords, getLocalDayKey, sumUsageTotalsForMonth, UsageService } from "../src/usage/UsageService";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import type { AskMateSettings, AskRequest, ReviewQueueItem, TokenUsageRecord } from "../src/shared/types";

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
});

function usageRecord(timestamp: string, totalTokens: number, overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
	return {
		id: timestamp, timestamp, providerId: "openai", providerName: "OpenAI", model: "gpt-5.5", title: "t", contextSource: "Current note", sourcePath: "",
		inputTokens: totalTokens, outputTokens: 0, totalTokens, cachedInputTokens: 0, reasoningOutputTokens: 0, durationMs: 1, estimated: false,
		operationKind: "text_response", outputMode: "chat", promptVersion: "test", status: "completed", endpoint: "responses", errorMessage: "",
		...overrides
	};
}

describe("UsageService budgets", () => {
	test("monthly use counts every day, not only the last 120 records", async () => {
		const settings = createSettings({ usageGuardrailsEnabled: true, usageMonthlyTokenBudget: 1000, usageBudgetEnforcement: "block" });
		const usage = new UsageService({ getSettings: () => settings, saveSettings: async () => undefined });
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
		const today = new Date();
		const totals = buildUsageTotalsFromRecords([
			usageRecord(today.toISOString(), 10),
			usageRecord(today.toISOString(), 99, { estimated: true, status: "aborted" })
		]);
		expect(totals[getLocalDayKey(today)]).toBe(10);
		expect(sumUsageTotalsForMonth({ "2026-01-01": 5, "2026-01-31": 6, "2026-02-01": 7 }, "2026-01")).toBe(11);
	});
});
