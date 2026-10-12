import { describe, expect, test } from "bun:test";
import { McpService } from "../src/mcp";
import { McpApprovalRouter } from "../src/plugin/mcpHost";
import type { ProviderRequestOptions, ProviderRuntime } from "../src/providers/types";
import { RequestRunner, type RequestRunnerHost } from "../src/requests/RequestRunner";
import type { RunOptions, ToolApprovalChoice, ToolUiEvent } from "../src/requests/runTypes";
import { previewToolResult } from "../src/requests/toolRun";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import type { AskMateHttpResponse, AskMateSettings, AskRequest, NoteContext, ProviderModelRef } from "../src/shared/types";
import { createHarness, fakeHttp, fakeServer, httpServer, type Harness } from "./mcp/fake-host";

type UsageParams = Parameters<RequestRunnerHost["recordOperationUsage"]>[0];

const USAGE = { input_tokens: 40, output_tokens: 8, total_tokens: 48 };

function reply(body: unknown): AskMateHttpResponse<unknown> {
	return { status: 200, ok: true, body, text: JSON.stringify(body) };
}

function toolCallReply(name: string, args: Record<string, unknown>): AskMateHttpResponse<unknown> {
	return reply({
		status: "completed",
		output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: JSON.stringify(args), status: "completed" }],
		usage: USAGE
	});
}

function answerReply(text: string): AskMateHttpResponse<unknown> {
	return reply({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: USAGE });
}

function ref(model: string): ProviderModelRef {
	return { providerId: "openai", providerName: "OpenAI", model, capability: "text" };
}

function noteContext(content: string): NoteContext {
	return { content, file: null, source: "Current note", attachments: [] };
}

function makeRequest(model = "gpt-5.5"): AskRequest {
	return {
		context: noteContext("The roadmap: ship on Friday."),
		question: "When do we ship?",
		title: "Test",
		evidenceSources: [],
		metadata: {
			intentKind: "freeform_text",
			commandSource: "sidebar",
			outputMode: "chat",
			promptVersion: "test",
			providerId: "openai",
			providerName: "OpenAI",
			selectedModel: model,
			modelCapability: "text",
			reasoningEffort: "medium",
			privacy: { includeNoteContext: true, includeImageReferences: true },
			contextBudgetMode: "expanded",
			contextBudgetLimitCharacters: null,
			contextTruncated: false,
			contextCharacters: 0,
			promptContextCharacters: 0,
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
			createdAt: "2026-10-01T00:00:00.000Z"
		}
	};
}

interface Rig {
	runner: RequestRunner;
	service: McpService;
	harness: Harness;
	records: UsageParams[];
	bodies: Array<Record<string, unknown>>;
	notices: string[];
	server: ReturnType<typeof fakeServer>;
	toolName: string;
}

/** A real McpService behind a fake server, a real runner, and a provider that plays back the replies it is given. */
async function createRig(
	replies: (toolName: string) => AskMateHttpResponse<unknown>[],
	model = "gpt-5.5",
	options: { hangToolCall?: boolean } = {}
): Promise<Rig> {
	const server = fakeServer();
	const front = fakeHttp(server);
	// A server that takes the tools/call and never answers, so a call is still running when the person presses Stop.
	const http = options.hangToolCall
		? { ...front, send: ((request) => (String(request.body).includes('"tools/call"') ? new Promise<never>(() => undefined) : front.send(request))) satisfies typeof front.send }
		: front;
	const harness = createHarness({ servers: [httpServer("fake")], http: { fake: http } });
	const router = new McpApprovalRouter();
	const service = new McpService({ ...harness.host, confirmCall: (card, signal) => router.confirm(card, signal) });
	await service.trust("fake");
	const toolName = (await service.prepareRun()).tools[0]?.modelName ?? "";

	const queue = [...replies(toolName)];
	const bodies: Array<Record<string, unknown>> = [];
	const records: UsageParams[] = [];
	const notices: string[] = [];
	const settings: AskMateSettings = { ...DEFAULT_SETTINGS };
	const runtime: ProviderRuntime = {
		getProviderSettings: () => ({ apiKeySecretName: "", model, modelOptions: [], baseUrl: "https://example.test/v1" }),
		getProviderApiKey: () => Promise.resolve("sk-test"),
		requestJson: <T,>(_url: string, options?: ProviderRequestOptions): Promise<AskMateHttpResponse<T>> => {
			bodies.push(JSON.parse(options?.body ?? "{}") as Record<string, unknown>);
			const next = queue.shift();
			return next ? Promise.resolve(next as AskMateHttpResponse<T>) : Promise.reject(new Error("Unexpected provider request"));
		}
	};
	const host: RequestRunnerHost = {
		getSettings: () => settings,
		getProviderRuntime: () => runtime,
		getOpenAiApiKey: () => Promise.resolve("sk-test"),
		getSelectedProviderModelRef: () => ref(model),
		getSelectedReasoningEffort: () => "medium",
		getImagePlanningProviderRef: () => ref(model),
		getImagePlanningModel: () => model,
		shouldGenerateImageFromQuestion: () => false,
		recordOperationUsage: (params) => {
			records.push(params);
			return Promise.resolve();
		},
		getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
		expandWorkflowPrompt: () => "",
		getNoteContext: () => Promise.resolve(noteContext("Note.")),
		getFileNoteContext: () => Promise.resolve(noteContext("Note.")),
		getFullNoteContext: () => Promise.resolve(noteContext("Note.")),
		buildContextAttachments: () => Promise.resolve([]),
		notify: (message) => {
			notices.push(message);
		},
		extensions: {
			tools: {
				getService: () => service,
				registerApproval: (signal, handler) => router.register(signal, handler),
				// The default dialog is a refusal here, so a run that brings no card of its own can never call a tool.
				confirmCall: () => Promise.resolve("deny")
			}
		},
		throwIfAborted: (signal) => {
			if (signal?.aborted) {
				throw new DOMException("The request was stopped.", "AbortError");
			}
		}
	};
	return { runner: new RequestRunner(host), service, harness, records, bodies, notices, server, toolName };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	expect(predicate()).toBe(true);
}

describe("a tool run end to end", () => {
	test("an approved call runs, its result reaches the model, and the answer is the last turn", async () => {
		const rig = await createRig((tool) => [toolCallReply(tool, { q: "roadmap" }), answerReply("We ship on Friday.")]);
		const events: ToolUiEvent[] = [];
		const cards: Array<Parameters<NonNullable<RunOptions["confirmToolCall"]>>[0]> = [];
		const request = makeRequest();
		const result = await rig.runner.runOpenAIRequest(request, {
			toolsEnabled: true,
			onToolEvent: (event) => events.push(event),
			confirmToolCall: (card) => {
				cards.push(card);
				return Promise.resolve<ToolApprovalChoice>("allow-once");
			}
		});

		expect(result.kind === "text" ? result.text : "").toBe("We ship on Friday.");
		expect(result.kind === "text" ? result.incompleteReason : "x").toBeNull();
		// The card shows the full arguments the server will receive.
		expect(cards).toHaveLength(1);
		expect(JSON.parse(cards[0]?.argumentsJson ?? "{}")).toEqual({ q: "roadmap" });
		expect(cards[0]?.server).toBe("Server fake");
		expect(rig.server.calls).toEqual([{ name: "search", args: { q: "roadmap" } }]);

		const statuses = events.map((event) => event.status);
		expect(statuses[0]).toBe("running");
		expect(statuses).toContain("pending-approval");
		expect(statuses.at(-1)).toBe("done");
		expect(events.at(-1)?.resultPreview).toContain("ran search");
		expect(result.kind === "text" ? result.toolCalls?.map((call) => call.status) : []).toEqual(["done"]);

		// Two model rounds, two usage records, both billed as tool rounds.
		expect(rig.records.map((record) => record.operationKind)).toEqual(["tool_round", "tool_round"]);
		expect(rig.records.every((record) => record.sent === true && record.status === "completed")).toBe(true);
		// The tools travel in the provider's tools field, and the result goes back as a function_call_output, never into the instructions.
		expect(JSON.stringify(rig.bodies[0]?.tools)).toContain(rig.toolName);
		expect(JSON.stringify(rig.bodies[1])).toContain("function_call_output");
		expect(String(rig.bodies[1]?.instructions)).not.toContain("ran search");
		expect(rig.runner.getRunFacts(request).toolDerived).toBe(true);
		expect(request.metadata.toolsEnabled).toBe(true);
	});

	test("a denied call never reaches the server and the model is told", async () => {
		const rig = await createRig((tool) => [toolCallReply(tool, { q: "x" }), answerReply("I could not look that up.")]);
		const events: ToolUiEvent[] = [];
		const result = await rig.runner.runOpenAIRequest(makeRequest(), {
			toolsEnabled: true,
			onToolEvent: (event) => events.push(event),
			confirmToolCall: () => Promise.resolve<ToolApprovalChoice>("deny")
		});

		expect(rig.server.calls).toEqual([]);
		expect(events.at(-1)?.status).toBe("denied");
		expect(JSON.stringify(rig.bodies[1])).toContain("did not allow");
		expect(result.kind === "text" ? result.text : "").toBe("I could not look that up.");
	});

	test("a run that brings no approval card is refused by default", async () => {
		const rig = await createRig((tool) => [toolCallReply(tool, { q: "x" }), answerReply("Done without it.")]);
		await rig.runner.runOpenAIRequest(makeRequest(), { toolsEnabled: true });
		expect(rig.server.calls).toEqual([]);
	});

	test("tools are off unless the run opts in", async () => {
		const rig = await createRig(() => [answerReply("Plain answer.")]);
		const request = makeRequest();
		const result = await rig.runner.runOpenAIRequest(request);

		expect(result.kind === "text" ? result.text : "").toBe("Plain answer.");
		expect(rig.bodies[0]?.tools).toBeUndefined();
		expect(rig.records.map((record) => record.operationKind)).toEqual(["text_response"]);
		expect(rig.runner.getRunFacts(request).toolDerived).toBe(false);
		expect(request.metadata.toolsEnabled).toBeUndefined();
	});

	test("Stop while a call waits for approval aborts the run and nothing runs", async () => {
		const rig = await createRig((tool) => [toolCallReply(tool, { q: "x" }), answerReply("never")]);
		const controller = new AbortController();
		const events: ToolUiEvent[] = [];
		const run = rig.runner.runOpenAIRequest(makeRequest(), {
			toolsEnabled: true,
			abortSignal: controller.signal,
			onToolEvent: (event) => events.push(event),
			confirmToolCall: () => new Promise<ToolApprovalChoice>(() => undefined)
		});
		await waitFor(() => events.some((event) => event.status === "pending-approval"));
		controller.abort();

		await expect(run).rejects.toThrow();
		expect(rig.server.calls).toEqual([]);
		// The card does not stay on "waiting for approval" after Stop.
		expect(events.at(-1)?.status).toBe("denied");
		expect(events.at(-1)?.error).toContain("Stopped");
	});

	test("Stop while a call is running leaves its card in a terminal state", async () => {
		const rig = await createRig((tool) => [toolCallReply(tool, { q: "x" }), answerReply("never")], "gpt-5.5", { hangToolCall: true });
		const controller = new AbortController();
		const events: ToolUiEvent[] = [];
		const run = rig.runner.runOpenAIRequest(makeRequest(), {
			toolsEnabled: true,
			abortSignal: controller.signal,
			onToolEvent: (event) => events.push(event),
			confirmToolCall: () => Promise.resolve<ToolApprovalChoice>("allow-once")
		});
		// Approved, then the call is sent and never answered.
		await waitFor(() => events.at(-1)?.status === "running" && events.some((event) => event.status === "pending-approval"));
		controller.abort();

		await expect(run).rejects.toThrow();
		const last = events.at(-1);
		expect(last?.status).toBe("error");
		expect(last?.error).toBe("Stopped");
		expect(last?.argumentsJson).toContain("\"q\"");
	});

	test("a model that cannot take tools gets a plain answer and a notice", async () => {
		const rig = await createRig(() => [answerReply("Plain answer.")], "o1-mini");
		const result = await rig.runner.runOpenAIRequest(makeRequest("o1-mini"), { toolsEnabled: true });

		expect(result.kind === "text" ? result.text : "").toBe("Plain answer.");
		expect(rig.notices.join(" ")).toContain("cannot use tools");
		expect(rig.bodies[0]?.tools).toBeUndefined();
	});

	test("a run that ends without an answer says why and does not invite a blind rerun", async () => {
		// The model keeps asking for tools until the loop runs out of turns.
		const rig = await createRig((tool) => Array.from({ length: 12 }, () => toolCallReply(tool, { q: "again" })));
		const error = await rig.runner.runOpenAIRequest(makeRequest(), {
			toolsEnabled: true,
			confirmToolCall: () => Promise.resolve<ToolApprovalChoice>("allow-once")
		}).then(() => new Error("resolved"), (caught: unknown) => (caught instanceof Error ? caught : new Error(String(caught))));

		expect(error.message).toMatch(/model turns|tool call/);
		expect(error.message).toMatch(/already ran/);
		expect(error.message).not.toMatch(/Try again/);
	});
});

describe("previewToolResult", () => {
	test("drops the wrapper the model sees and cuts long text", () => {
		expect(previewToolResult("<tool_result server=\"a\" tool=\"b\" status=\"ok\" trust=\"untrusted\">\nhello\n</tool_result>")).toBe("hello");
		expect(previewToolResult("x".repeat(2000)).length).toBeLessThanOrEqual(600);
	});
});
