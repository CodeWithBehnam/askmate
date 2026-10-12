import { describe, expect, test } from "bun:test";
import { McpService, type McpHttpServerConfig } from "../src/mcp";
import { McpApprovalRouter } from "../src/plugin/mcpHost";
import { fetchSse, type FetchLike } from "../src/providers/sseTransport";
import type { ProviderRequestOptions, ProviderRuntime } from "../src/providers/types";
import { RequestRunner, type RequestRunnerHost } from "../src/requests/RequestRunner";
import { buildRequestInstructions } from "../src/requests/requestBuilders";
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

interface RigOptions {
	hangToolCall?: boolean;
	/** The "Tool rounds per answer" and "Longest tool result" settings, applied to the runner and to the MCP service alike. */
	mcp?: { maxToolRoundsPerTurn?: number; maxOutputChars?: number };
	/** What the fake tool returns. */
	callText?: string;
	/** One entry per streamed request: its SSE frames. With any entry the runtime can stream, like Stream replies on. */
	streams?: (toolName: string) => string[][];
	/** Changes to the fake server's settings, such as its approval mode. It asks before every call unless this says otherwise. */
	server?: Partial<McpHttpServerConfig>;
}

/** A real McpService behind a fake server, a real runner, and a provider that plays back the replies it is given. */
async function createRig(
	replies: (toolName: string) => AskMateHttpResponse<unknown>[],
	model = "gpt-5.5",
	options: RigOptions = {}
): Promise<Rig> {
	const server = fakeServer(options.callText === undefined ? {} : { callResult: () => ({ content: [{ type: "text", text: options.callText ?? "" }] }) });
	const front = fakeHttp(server);
	// A server that takes the tools/call and never answers, so a call is still running when the person presses Stop.
	const http = options.hangToolCall
		? { ...front, send: ((request) => (String(request.body).includes('"tools/call"') ? new Promise<never>(() => undefined) : front.send(request))) satisfies typeof front.send }
		: front;
	const harness = createHarness({ servers: [httpServer("fake", options.server)], http: { fake: http } });
	harness.settings = { ...harness.settings, ...options.mcp };
	const router = new McpApprovalRouter();
	const service = new McpService({ ...harness.host, confirmCall: (card, signal) => router.confirm(card, signal) });
	await service.trust("fake");
	const toolName = (await service.prepareRun()).tools[0]?.modelName ?? "";

	const queue = [...replies(toolName)];
	const bodies: Array<Record<string, unknown>> = [];
	const records: UsageParams[] = [];
	const notices: string[] = [];
	const settings: AskMateSettings = { ...DEFAULT_SETTINGS, mcp: { ...DEFAULT_SETTINGS.mcp, ...options.mcp } };
	const streamQueue = [...(options.streams?.(toolName) ?? [])];
	const streamFetch: FetchLike = (_url, init) => {
		bodies.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
		const frames = streamQueue.shift();
		if (!frames) {
			return Promise.reject(new Error("Unexpected streamed provider request"));
		}
		const encoder = new TextEncoder();
		return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				frames.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
				controller.close();
			}
		}), { headers: { "content-type": "text/event-stream" } }));
	};
	const runtime: ProviderRuntime = {
		getProviderSettings: () => ({ apiKeySecretName: "", model, modelOptions: [], baseUrl: "https://example.test/v1" }),
		getProviderApiKey: () => Promise.resolve("sk-test"),
		requestJson: <T,>(_url: string, options?: ProviderRequestOptions): Promise<AskMateHttpResponse<T>> => {
			bodies.push(JSON.parse(options?.body ?? "{}") as Record<string, unknown>);
			const next = queue.shift();
			return next ? Promise.resolve(next as AskMateHttpResponse<T>) : Promise.reject(new Error("Unexpected provider request"));
		},
		...(options.streams ? { streamSse: (url, init, onEvent) => fetchSse(streamFetch, url, init, onEvent) } : {})
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

	test("the approval card offers Allow for this chat only for a server that reuses a chat grant", async () => {
		async function offered(server: Partial<McpHttpServerConfig>, chatId: string | null): Promise<boolean | undefined> {
			const rig = await createRig((tool) => [toolCallReply(tool, { q: "x" }), answerReply("Done.")], "gpt-5.5", { server });
			const cards: Array<Parameters<NonNullable<RunOptions["confirmToolCall"]>>[0]> = [];
			await rig.runner.runOpenAIRequest(makeRequest(), {
				toolsEnabled: true,
				chatId,
				confirmToolCall: (card) => {
					cards.push(card);
					return Promise.resolve<ToolApprovalChoice>("allow-once");
				}
			});
			expect(cards).toHaveLength(1);
			return cards[0]?.canAllowForChat;
		}

		expect(await offered({ approval: "always-ask" }, "chat-1")).toBe(false);
		expect(await offered({ approval: "ask-once-per-chat" }, "chat-1")).toBe(true);
		// With no conversation there is nothing to scope a grant to, whatever the mode.
		expect(await offered({ approval: "ask-once-per-chat" }, null)).toBe(false);
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

describe("the tool settings are the limits", () => {
	const allow = (): Promise<ToolApprovalChoice> => Promise.resolve("allow-once");

	test("the rounds setting is honoured exactly, up to its maximum", async () => {
		const rounds = 12;
		const rig = await createRig(
			(tool) => [...Array.from({ length: rounds }, () => toolCallReply(tool, { q: "again" })), answerReply("Enough looking.")],
			"gpt-5.5",
			{ mcp: { maxToolRoundsPerTurn: rounds } }
		);
		const result = await rig.runner.runOpenAIRequest(makeRequest(), { toolsEnabled: true, confirmToolCall: allow });

		expect(result.kind === "text" ? result.text : "").toBe("Enough looking.");
		expect(rig.server.calls).toHaveLength(rounds);
		// Twelve rounds of tools, then one answering turn without them.
		expect(rig.bodies).toHaveLength(rounds + 1);
		expect(rig.bodies.at(-1)?.tool_choice).toBe("none");
	});

	test("a low rounds setting ends the tool rounds there", async () => {
		const rig = await createRig(
			(tool) => [toolCallReply(tool, { q: "one" }), toolCallReply(tool, { q: "two" }), answerReply("Done after two.")],
			"gpt-5.5",
			{ mcp: { maxToolRoundsPerTurn: 2 } }
		);
		await rig.runner.runOpenAIRequest(makeRequest(), { toolsEnabled: true, confirmToolCall: allow });

		expect(rig.bodies.map((body) => body.tool_choice)).toEqual(["auto", "auto", "none"]);
	});

	test("a long result reaches the model whole when the setting allows it", async () => {
		const text = "A".repeat(50_000);
		const rig = await createRig((tool) => [toolCallReply(tool, { q: "long" }), answerReply("Read it all.")], "gpt-5.5", {
			mcp: { maxOutputChars: 100_000 },
			callText: text
		});
		await rig.runner.runOpenAIRequest(makeRequest(), { toolsEnabled: true, confirmToolCall: allow });

		const sent = JSON.stringify(rig.bodies[1]);
		expect(sent).toContain("A".repeat(50_000));
		expect(sent).not.toContain("AskMate cut this tool result");
	});

	test("a result cut by the setting keeps its closing tag and says it was cut once", async () => {
		const rig = await createRig((tool) => [toolCallReply(tool, { q: "long" }), answerReply("Read part of it.")], "gpt-5.5", {
			mcp: { maxOutputChars: 2_000 },
			callText: "B".repeat(9_000)
		});
		await rig.runner.runOpenAIRequest(makeRequest(), { toolsEnabled: true, confirmToolCall: allow });

		const output = String(JSON.stringify(rig.bodies[1]));
		expect(output).toContain("[Output cut after 2000 characters.]");
		expect(output).toContain("</tool_result>");
		expect(output).not.toContain("AskMate cut this tool result");
		expect(output.includes("B".repeat(2_001))).toBe(false);
	});

	test("the tools section states the rounds and the calls the run really has, and a rebuilt request says the same", async () => {
		const rig = await createRig(() => [answerReply("No tools needed.")], "gpt-5.5", { mcp: { maxToolRoundsPerTurn: 3 } });
		const request = makeRequest();
		await rig.runner.runOpenAIRequest(request, { toolsEnabled: true, confirmToolCall: allow });

		const sent = String(rig.bodies[0]?.instructions);
		expect(sent).toContain("You have at most 3 rounds of tool calls");
		expect(sent).toContain("The turn after the last round has no tools");
		expect(sent).toContain("Use at most 12 tool calls in one run.");
		expect(request.tools).toMatchObject({ maxRounds: 3, maxCalls: 12 });
		expect(buildRequestInstructions(request, { purpose: "answer" })).toBe(sent);
	});
});

describe("a tool run streams its answer", () => {
	const allow = (): Promise<ToolApprovalChoice> => Promise.resolve("allow-once");
	const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
	const completed = frame({ type: "response.completed", response: { status: "completed", output: [], usage: USAGE } });
	const callTurn = (tool: string): string[] => [
		frame({ type: "response.output_text.delta", output_index: 0, delta: "Checking." }),
		frame({ type: "response.output_item.done", output_index: 0, item: { type: "message", phase: "commentary", content: [{ type: "output_text", text: "Checking." }] } }),
		frame({ type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_1", name: tool, arguments: "{\"q\":\"roadmap\"}", status: "completed" } }),
		completed
	];
	const answerTurn = [
		frame({ type: "response.output_text.delta", output_index: 0, delta: "We ship " }),
		frame({ type: "response.output_text.delta", output_index: 0, delta: "on Friday." }),
		frame({ type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "We ship on Friday." }] } }),
		completed
	];

	test("the final turn arrives as it is written, and progress text before a tool call is cleared", async () => {
		const rig = await createRig(() => [], "gpt-5.5", { streams: (tool) => [callTurn(tool), answerTurn] });
		const events: string[] = [];
		const result = await rig.runner.runOpenAIRequest(makeRequest(), {
			toolsEnabled: true,
			confirmToolCall: allow,
			onTextDelta: (delta) => events.push(`delta:${delta}`),
			onTextReset: () => events.push("reset")
		});

		expect(result.kind === "text" ? result.text : "").toBe("We ship on Friday.");
		// The answer is not sent a second time at the end.
		expect(events).toEqual(["delta:Checking.", "reset", "delta:We ship ", "delta:on Friday."]);
		expect(rig.bodies.every((body) => body.stream === true)).toBe(true);
	});

	test("without a listener the turns stay buffered, as before", async () => {
		const rig = await createRig((tool) => [toolCallReply(tool, { q: "roadmap" }), answerReply("We ship on Friday.")], "gpt-5.5", { streams: () => [] });
		const result = await rig.runner.runOpenAIRequest(makeRequest(), { toolsEnabled: true, confirmToolCall: allow });

		expect(result.kind === "text" ? result.text : "").toBe("We ship on Friday.");
		expect(rig.bodies.some((body) => body.stream === true)).toBe(false);
	});

	test("a caller that cannot clear progress text gets the answer in one piece, so narration never piles up in front of it", async () => {
		// The runtime can stream and the model narrates before its tool call, but this caller has no onTextReset.
		const rig = await createRig(
			(tool) => [toolCallReply(tool, { q: "roadmap" }), answerReply("We ship on Friday.")],
			"gpt-5.5",
			{ streams: (tool) => [callTurn(tool), answerTurn] }
		);
		const deltas: string[] = [];
		const result = await rig.runner.runOpenAIRequest(makeRequest(), {
			toolsEnabled: true,
			confirmToolCall: allow,
			onTextDelta: (delta) => deltas.push(delta)
		});

		expect(result.kind === "text" ? result.text : "").toBe("We ship on Friday.");
		expect(deltas).toEqual(["We ship on Friday."]);
		expect(rig.bodies.some((body) => body.stream === true)).toBe(false);
	});

	test("a runtime that cannot stream still delivers the answer in one piece", async () => {
		const rig = await createRig((tool) => [toolCallReply(tool, { q: "roadmap" }), answerReply("We ship on Friday.")]);
		const deltas: string[] = [];
		const resets: number[] = [];
		await rig.runner.runOpenAIRequest(makeRequest(), {
			toolsEnabled: true,
			confirmToolCall: allow,
			onTextDelta: (delta) => deltas.push(delta),
			onTextReset: () => resets.push(1)
		});

		expect(deltas).toEqual(["We ship on Friday."]);
		expect(resets).toEqual([]);
	});
});

describe("previewToolResult", () => {
	test("drops the wrapper the model sees and cuts long text", () => {
		expect(previewToolResult("<tool_result server=\"a\" tool=\"b\" status=\"ok\" trust=\"untrusted\">\nhello\n</tool_result>")).toBe("hello");
		expect(previewToolResult("x".repeat(2000)).length).toBeLessThanOrEqual(600);
	});
});
