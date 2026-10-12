import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import AskMatePlugin from "../src/plugin/AskMatePlugin";
import {
	INITIAL_BATCH_STATE,
	MAX_CONSECUTIVE_BATCH_FAILURES,
	batchResultTitle,
	classifyBatchFailure,
	describeEmptyBatch,
	nextBatchDecision
} from "../src/plugin/batchPolicy";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import type { AskRequest, BatchWorkflowRunOptions } from "../src/shared/types";
import { UsageService } from "../src/usage/UsageService";
import { createFakeApp, type FakeApp } from "./support/fake-app";
import { installDomGlobals } from "./support/fake-dom";
import { Modal, Notice } from "./support/obsidian-fakes";

let restoreDom: () => void;

beforeAll(() => {
	restoreDom = installDomGlobals();
});

afterAll(() => {
	restoreDom();
});

beforeEach(() => {
	Notice.clear();
});

describe("batch failure policy", () => {
	test("sorts failures into the kinds that repeat for every note and the ones that do not", () => {
		expect(classifyBatchFailure("OpenAI authentication failed (HTTP 401).")).toBe("auth");
		expect(classifyBatchFailure("Add an OpenAI API key in AskMate settings before asking a question.")).toBe("auth");
		expect(classifyBatchFailure("Images use OpenAI. In AskMate settings, open Connection and add an OpenAI API key (under Images, if another provider is selected) before generating an image.")).toBe("auth");
		expect(classifyBatchFailure("Daily budget reached. AskMate blocked the request.")).toBe("guardrail");
		expect(classifyBatchFailure("The note could not be read.")).toBe("other");
	});

	test("a note that is too long for the context budget is a per-note failure, not a guardrail", () => {
		const truncated = "The note was longer than the context budget, so AskMate will not queue a full-note replacement that would drop the unsent part. Use the Expanded context budget for this note.";
		expect(classifyBatchFailure(truncated)).toBe("other");
		expect(classifyBatchFailure("The reply was incomplete (max_output_tokens), so AskMate did not use it.")).toBe("other");
		expect(classifyBatchFailure("This model's maximum context length is 128000 tokens. Reduce the token limit of your request.")).toBe("other");

		// Three such notes in a row do not end the batch.
		let state = INITIAL_BATCH_STATE;
		const stops = [truncated, truncated, truncated].map((message) => {
			const decision = nextBatchDecision(state, classifyBatchFailure(message));
			state = decision.state;
			return decision.stopReason;
		});
		expect(stops).toEqual([null, null, null]);
	});

	test("every blocker the usage guardrails can raise is still a guardrail failure", () => {
		const usage = new UsageService({
			getSettings: () => ({
				...DEFAULT_SETTINGS,
				usageGuardrailsEnabled: true,
				usagePerRequestHardLimitTokens: 1_000,
				usageDailyTokenBudget: 100,
				usageMonthlyTokenBudget: 100,
				usageBudgetEnforcement: "block"
			}),
			saveSettings: () => Promise.resolve()
		});
		const { blockers } = usage.evaluateUsageGuardrails({} as AskRequest, 5_000);

		expect(blockers).toHaveLength(3);
		expect(blockers.map((message) => classifyBatchFailure(message))).toEqual(["guardrail", "guardrail", "guardrail"]);
		expect(classifyBatchFailure("AskMate request cancelled by usage guardrails.")).toBe("guardrail");
	});

	test("three failures of the same kind in a row end the batch, and anything else starts the count again", () => {
		let state = INITIAL_BATCH_STATE;
		const decisions = ["auth", "auth", "other", "auth", "auth", "auth"] as const;
		const stops = decisions.map((kind) => {
			const decision = nextBatchDecision(state, kind);
			state = decision.state;
			return decision.stopReason !== null;
		});

		expect(stops).toEqual([false, false, false, false, false, true]);
		expect(MAX_CONSECUTIVE_BATCH_FAILURES).toBe(3);
		expect(nextBatchDecision({ consecutive: 2, kind: "auth" }, null).state).toEqual(INITIAL_BATCH_STATE);
		expect(nextBatchDecision({ consecutive: 2, kind: "auth" }, "guardrail").state).toEqual({ consecutive: 1, kind: "guardrail" });
		expect(nextBatchDecision({ consecutive: 2, kind: "auth" }, "auth").stopReason).toMatch(/provider rejected/);
	});

	test("titles and the empty-batch wording", () => {
		expect(batchResultTitle("Study summary", "Lecture 3")).toBe("Study summary - Lecture 3");
		expect(batchResultTitle("Study summary", "")).toBe("Study summary");
		expect(describeEmptyBatch("Projects", true)).toBe("No Markdown notes were found in Projects.");
		expect(describeEmptyBatch("Projects", false)).toBe("The folder Projects does not exist in this vault.");
	});
});

interface TestPlugin extends AskMatePlugin {
	storedData: unknown;
}

async function loadPlugin(): Promise<{ plugin: TestPlugin; fake: FakeApp }> {
	const fake = createFakeApp();
	const plugin = new AskMatePlugin(fake.app as never, { id: "askmate", name: "AskMate", version: "1.12.0", dir: ".obsidian/plugins/askmate" } as never) as TestPlugin;
	plugin.storedData = {};
	plugin.obsidianApi = { loadMermaid: () => Promise.resolve(null), parseYaml: (text) => Bun.YAML.parse(text) };
	await plugin.onload();
	return { plugin, fake };
}

function answerDialogs(): { stop: () => void } {
	const timer = setInterval(() => {
		for (const modal of [...Modal.opened]) {
			modal.contentEl.querySelector<HTMLElement>("button.mod-cta")?.click();
		}
	}, 1);
	return { stop: () => clearInterval(timer) };
}

const OPTIONS: BatchWorkflowRunOptions = {
	folderPath: "Batch",
	workflowId: "study-summary",
	maxFiles: 10,
	outputMode: "note",
	contextBudgetMode: "expanded"
};

describe("batch runs", () => {
	test("a folder that does not exist stops with its path instead of reporting zero completed", async () => {
		const { plugin } = await loadPlugin();

		const summary = await plugin.runBatchWorkflow({ ...OPTIONS, folderPath: "Nowhere" });

		expect(summary.stoppedReason).toBe("The folder Nowhere does not exist in this vault.");
		expect(summary.total).toBe(0);
	});

	test("a folder with no notes stops with its path", async () => {
		const { plugin, fake } = await loadPlugin();
		fake.vault.addFolder("Batch");

		const summary = await plugin.runBatchWorkflow(OPTIONS);

		expect(summary.stoppedReason).toBe("No Markdown notes were found in Batch.");
	});

	test("three notes in a row rejected by the provider end the batch before the fourth", async () => {
		const { plugin, fake } = await loadPlugin();
		for (const name of ["A", "B", "C", "D", "E"]) {
			fake.vault.add(`Batch/${name}.md`, `Note ${name}`);
		}
		const attempted: string[] = [];
		Object.assign(plugin, {
			runOpenAIRequest: (request: AskRequest) => {
				attempted.push(request.context.file?.basename ?? "?");
				return Promise.reject(new Error("OpenAI authentication failed (HTTP 401)."));
			}
		});
		const dialogs = answerDialogs();

		const summary = await plugin.runBatchWorkflow(OPTIONS);
		dialogs.stop();

		expect(attempted).toEqual(["A", "B", "C"]);
		expect(summary.failed).toBe(3);
		expect(summary.stoppedReason).toMatch(/3 notes in a row failed because the provider rejected the request/);
	});

	test("each result note is named for the workflow and its source note, and a slow settings change does not alter later notes", async () => {
		const { plugin, fake } = await loadPlugin();
		fake.vault.add("Batch/Alpha.md", "Alpha text");
		fake.vault.add("Batch/Beta.md", "Beta text");
		const models: string[] = [];
		Object.assign(plugin, {
			runOpenAIRequest: (request: AskRequest) => {
				models.push(`${request.metadata.selectedModel}/${request.metadata.reasoningEffort}`);
				// The person changes the model and effort while the batch is still running.
				plugin.settings.providers.openai.model = "gpt-5.5-mini";
				plugin.settings.reasoningEffort = "high";
				return Promise.resolve({ kind: "text", model: request.metadata.selectedModel, text: "Summary", incompleteReason: null });
			}
		});
		const dialogs = answerDialogs();

		const summary = await plugin.runBatchWorkflow(OPTIONS);
		dialogs.stop();

		expect(summary.completed).toBe(2);
		expect(summary.createdNotes.map((path) => path.split("/").pop()).sort()).toEqual([
			expect.stringContaining("Study summary - Alpha"),
			expect.stringContaining("Study summary - Beta")
		]);
		expect(models[0]).toBe(models[1]);
		expect(models[1]?.startsWith("gpt-5.5/")).toBe(true);
	});

	test("a note that is too large for a batch is skipped and named, and the rest still run", async () => {
		const { plugin, fake } = await loadPlugin();
		fake.vault.add("Batch/Big.md", "word ".repeat(160_000));
		fake.vault.add("Batch/Small.md", "Short note");
		Object.assign(plugin, {
			runOpenAIRequest: (request: AskRequest) => Promise.resolve({ kind: "text", model: request.metadata.selectedModel, text: "Summary", incompleteReason: null })
		});
		const dialogs = answerDialogs();

		const summary = await plugin.runBatchWorkflow(OPTIONS);
		dialogs.stop();

		expect(summary.completed).toBe(1);
		expect(summary.failures).toHaveLength(1);
		expect(summary.failures[0]?.path).toBe("Batch/Big.md");
		expect(summary.failures[0]?.reason).toContain("A batch does not send notes this large");
	});
});
