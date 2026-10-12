/**
 * One tool-using answer: asks the MCP service for the run's frozen tool snapshot, drives the provider-neutral tool loop,
 * keeps one card per call up to date, and records one usage entry per model round. Nothing here knows about Obsidian
 * or a provider wire format; the shell injects the sender, the usage recorder and the approval dialog.
 *
 * Approval has a single authority. McpService decides whether a call needs the person's consent (its mode, chat grants,
 * a changed tool definition) and asks through the registered handler, so the loop itself never prompts. Default-deny:
 * anything but an explicit "allow-once" or "allow-chat" is a refusal.
 */
import {
	describeToolLoopEnd,
	type HistoryItem,
	type ToolCall,
	type ToolChoice,
	type ToolLoopEnd,
	type ToolLoopLimits,
	type ToolLoopProgress,
	type ToolSpec,
	type TurnResult,
	type Usage,
	runToolLoop
} from "../providers/tools";
import { isAbortError } from "../shared/core";
import type { OperationStatus } from "../shared/types";
import type { McpServerStatus, SnapshotTool, ToolApprovalCard as McpApprovalCard, ToolOutcome, ToolSnapshot } from "../mcp";
import type { RunPhaseEvent, ToolApprovalCard, ToolApprovalChoice, ToolRunHost, ToolUiEvent, ToolUiStatus, ToolsPort } from "./runTypes";

export type SendTurn = (history: readonly HistoryItem[], toolChoice: ToolChoice, signal: AbortSignal) => Promise<TurnResult>;

/** What one model round cost, in the shape the usage recorder takes. */
export interface RoundRecord {
	status: OperationStatus;
	usage: Usage | null;
	/** Text that came back, the answer or the narration beside tool calls. */
	responseText: string;
	startedAt: Date;
	errorMessage?: string;
	/** The history as plain text, for the estimate used when the provider reports no usage. */
	input: string;
	/** True once the request was handed to the provider. */
	sent: boolean;
}

export interface ToolRunDeps {
	service: ToolsPort;
	signal: AbortSignal;
	chatId: string | null;
	limits: ToolLoopLimits;
	/** The request message: note context, question and rules. Tool results never go into the instructions. */
	userText: string;
	/** Called once the snapshot is known. The caller adds the tools section to its instructions and builds the sender. */
	prepare(snapshot: ToolSnapshot, specs: readonly ToolSpec[]): { sendTurn: SendTurn };
	recordRound(round: RoundRecord): Promise<void>;
	registerApproval: ToolRunHost["registerApproval"];
	confirmCall: (card: ToolApprovalCard) => Promise<ToolApprovalChoice>;
	onToolEvent?: (event: ToolUiEvent) => void;
	onPhase?: (phase: RunPhaseEvent) => void;
	now?: () => Date;
}

export type ToolRunResult =
	/** No server is ready, so nothing was attached. The caller answers without tools. */
	| { kind: "no-tools"; unavailable: readonly McpServerStatus[] }
	| {
		kind: "finished";
		answer: string;
		end: ToolLoopEnd;
		/** One sentence for the user when the run ended without an answer; empty for an answer. */
		endMessage: string;
		toolCalls: ToolUiEvent[];
		toolCallsRun: number;
		turns: number;
		usage: Usage | null;
		serverLabels: string[];
	};

const MAX_PREVIEW_CHARACTERS = 600;
const MAX_ERROR_CHARACTERS = 300;
const MAX_NAME_CHARACTERS = 80;
const RESULT_WRAPPER = /^\s*<tool_result\b[^>]*>\s*/i;
const RESULT_WRAPPER_END = /\s*<\/tool_result>\s*$/i;

/** Control characters out and a length cap, for a name the model chose and a card shows. */
function displayName(raw: string): string {
	// eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
	const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	return clean.length > MAX_NAME_CHARACTERS ? `${clean.slice(0, MAX_NAME_CHARACTERS - 3)}...` : clean;
}

function clip(text: string, max: number): string {
	const plain = text.trim();
	return plain.length > max ? `${plain.slice(0, max - 3)}...` : plain;
}

/** The text a card previews: the result without the wrapper tags the model sees, cut short. */
export function previewToolResult(text: string): string {
	return clip(text.replace(RESULT_WRAPPER, "").replace(RESULT_WRAPPER_END, ""), MAX_PREVIEW_CHARACTERS);
}

function statusFor(outcome: ToolOutcome | undefined, isError: boolean): ToolUiStatus {
	if (!outcome) {
		return isError ? "error" : "done";
	}
	switch (outcome.status) {
		case "ok":
			return "done";
		case "denied":
			return "denied";
		case "tool_error":
		case "failed":
		case "aborted":
			return "error";
	}
}

/** Plain text of a history, so a round without reported usage still gets a sensible estimate. */
export function describeHistory(history: readonly HistoryItem[]): string {
	return history.map((item) => {
		switch (item.kind) {
			case "user":
				return item.text;
			case "assistant":
				return [item.text, ...item.toolCalls.map((call) => `${call.name} ${call.rawInput}`)].filter(Boolean).join("\n");
			case "tool_results":
				return item.results.map((result) => result.text).join("\n");
		}
	}).join("\n\n");
}

/** Wire specs for the attached tools. The model-facing name is the snapshot's, used exactly as given. */
export function buildToolSpecs(snapshot: ToolSnapshot): ToolSpec[] {
	return snapshot.tools.map((tool): ToolSpec => ({ name: tool.modelName, description: tool.description, inputSchema: tool.inputSchema }));
}

/** The host's approval card as the sidebar shows it. The caller sets `id` to the call being run. */
export function toUiApprovalCard(card: McpApprovalCard, id = ""): ToolApprovalCard {
	return {
		id,
		server: card.serverLabel,
		tool: card.toolName,
		title: card.toolTitle,
		description: card.description,
		argumentsJson: card.argumentsText,
		changedSinceApproval: card.changedSinceApproval,
		canAllowForChat: card.canAllowForChat
	};
}

function namesFor(snapshot: ToolSnapshot, modelName: string): { server: string; tool: string } {
	const tool: SnapshotTool | undefined = snapshot.byModelName.get(modelName);
	return tool ? { server: displayName(tool.serverLabel), tool: displayName(tool.title || tool.toolName) } : { server: "unknown", tool: displayName(modelName) };
}

function argumentsOf(call: ToolCall): string {
	return call.inputError ? call.rawInput : JSON.stringify(call.input, null, 2);
}

export async function runToolsTurn(deps: ToolRunDeps): Promise<ToolRunResult> {
	const now = deps.now ?? ((): Date => new Date());
	const snapshot = await deps.service.prepareRun(deps.signal);
	if (snapshot.tools.length === 0) {
		return { kind: "no-tools", unavailable: snapshot.unavailable };
	}

	const specs = buildToolSpecs(snapshot);
	const prepared = deps.prepare(snapshot, specs);
	const events = new Map<string, ToolUiEvent>();
	const outcomes = new Map<string, ToolOutcome>();
	let current: string | null = null;

	const emit = (event: ToolUiEvent): void => {
		events.set(event.id, event);
		deps.onToolEvent?.({ ...event });
	};

	const send: SendTurn = async (history, toolChoice, signal) => {
		const startedAt = now();
		const input = describeHistory(history);
		const sent = !signal.aborted;
		try {
			const result = await prepared.sendTurn(history, toolChoice, signal);
			await deps.recordRound({ status: "completed", usage: result.usage, responseText: result.text || result.narration, startedAt, input, sent: true });
			return result;
		} catch (error) {
			await deps.recordRound({
				status: isAbortError(error) ? "aborted" : "failed",
				usage: null,
				responseText: "",
				startedAt,
				errorMessage: error instanceof Error ? error.message : String(error),
				input,
				sent
			});
			throw error;
		}
	};

	const onProgress = (event: ToolLoopProgress): void => {
		switch (event.kind) {
			case "turn":
				deps.onPhase?.("tool-calling");
				return;
			case "narration":
				return;
			case "call": {
				current = event.call.id;
				emit({ id: event.call.id, ...namesFor(snapshot, event.call.name), status: "running", argumentsJson: argumentsOf(event.call) });
				return;
			}
			case "result": {
				const { call, result } = event;
				const outcome = outcomes.get(call.id);
				const status = statusFor(outcome, result.isError);
				const previous = events.get(call.id);
				const error = status === "error" ? clip(outcome?.message ?? result.text, MAX_ERROR_CHARACTERS) : undefined;
				emit({
					id: call.id,
					...(previous ? { server: previous.server, tool: previous.tool } : namesFor(snapshot, call.name)),
					status,
					argumentsJson: previous?.argumentsJson ?? argumentsOf(call),
					...(status === "done" ? { resultPreview: previewToolResult(result.text) } : {}),
					...(error ? { error } : {})
				});
				if (current === call.id) {
					current = null;
				}
				return;
			}
		}
	};

	/**
	 * A run that ends early (Stop, or a failure) while a call waits for approval or runs would leave its card at
	 * pending-approval or running for good, and a saved thread would record it that way. Every such card gets a terminal state.
	 */
	const settleOpenCalls = (cause: unknown): void => {
		const stopped = isAbortError(cause) || deps.signal.aborted;
		const reason = stopped ? "Stopped" : clip(cause instanceof Error ? cause.message : String(cause), MAX_ERROR_CHARACTERS);
		for (const event of [...events.values()]) {
			if (event.status === "pending-approval") {
				emit({ ...event, status: "denied", error: stopped ? "Stopped before it was approved" : reason });
			} else if (event.status === "running") {
				emit({ ...event, status: "error", error: reason });
			}
		}
	};

	const unregister = deps.registerApproval(deps.signal, async (card) => {
		const callId = current ?? card.id;
		const base = events.get(callId);
		deps.onPhase?.("awaiting-approval");
		if (base) {
			emit({ ...base, status: "pending-approval" });
		}
		try {
			return await deps.confirmCall({ ...card, id: callId });
		} finally {
			deps.onPhase?.("tool-calling");
			const latest = events.get(callId);
			if (latest && latest.status === "pending-approval") {
				emit({ ...latest, status: "running" });
			}
		}
	});

	try {
		const loop = await runToolLoop(
			{
				sendTurn: send,
				tools: {
					has: (name) => snapshot.byModelName.has(name),
					// McpService asks through the registered handler, so the loop never prompts a second time.
					needsApproval: () => false,
					run: async (call, signal) => {
						const outcome = await deps.service.callTool({ snapshot, callId: call.id, modelName: call.name, args: call.input, chatId: deps.chatId }, signal);
						outcomes.set(call.id, outcome);
						return { text: outcome.text, isError: outcome.status !== "ok" };
					}
				},
				approve: () => Promise.resolve(false),
				onProgress,
				signal: deps.signal
			},
			[{ kind: "user", text: deps.userText }],
			deps.limits
		);
		return {
			kind: "finished",
			answer: loop.answer,
			end: loop.end,
			endMessage: describeToolLoopEnd(loop),
			toolCalls: [...events.values()],
			toolCallsRun: loop.toolCallsRun,
			turns: loop.turns,
			usage: loop.usage,
			serverLabels: snapshot.servers.map((server) => server.label)
		};
	} catch (error) {
		settleOpenCalls(error);
		throw error;
	} finally {
		unregister();
	}
}
