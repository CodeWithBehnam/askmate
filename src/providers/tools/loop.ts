/**
 * Provider-agnostic tool loop. It knows nothing about wire formats: it sends a turn, runs approved calls one at a time,
 * and appends the results. Safety rules live here so they are enforced once, not per provider.
 */
import { createAbortError, isAbortError } from "../../settings/normalize";
import { redactSecrets } from "../common";
import {
	addUsage,
	type HistoryItem,
	type ToolCall,
	type ToolChoice,
	type ToolResult,
	type TurnResult,
	type Usage
} from "./neutral";

export interface ToolLoopLimits {
	/** Model round trips, including the first. */
	maxTurns: number;
	/** Tool executions across the whole run. Calls that were invalid, unknown or declined do not count. */
	maxToolCalls: number;
	/** Characters of one tool result sent back to the model, including the notice that it was cut. */
	maxResultChars: number;
}

export const DEFAULT_TOOL_LOOP_LIMITS: ToolLoopLimits = { maxTurns: 8, maxToolCalls: 12, maxResultChars: 12000 };

export interface ToolRuntime {
	/** True when `name` is one of the wire names this run was given. The model's own spelling is never trusted. */
	has(name: string): boolean;
	/** Runs one call. Must reject on abort; should not throw for ordinary tool failures (return isError). */
	run(call: ToolCall, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
	/** Read-only first-party tools return false. MCP tools return true unless the user trusted the server for reads. */
	needsApproval(call: ToolCall): boolean;
}

export type ToolLoopProgress =
	| { kind: "turn"; turn: number; maxTurns: number }
	/** Text the model wrote beside tool calls. Progress only; it is never the answer. */
	| { kind: "narration"; turn: number; text: string }
	/** A call is about to run (approval, if needed, is already granted). `turn` plus `call.id` identify it for the run. */
	| { kind: "call"; turn: number; call: ToolCall }
	| { kind: "result"; turn: number; call: ToolCall; result: ToolResult };

export interface ToolLoopDeps {
	/** One model round trip. `signal` is the run's own, so a stop reaches the HTTP request and the stream. */
	sendTurn(history: readonly HistoryItem[], toolChoice: ToolChoice, signal: AbortSignal): Promise<TurnResult>;
	tools: ToolRuntime;
	/** Resolves true to run the call. Shown with the real arguments, never a summary the model wrote. */
	approve(call: ToolCall): Promise<boolean>;
	onProgress(event: ToolLoopProgress): void;
	signal: AbortSignal;
}

export type ToolLoopEnd =
	| "answered"
	/** The model finished a turn with no tool call and no text. */
	| "empty_answer"
	| "turn_limit"
	| "call_limit"
	| "truncated"
	| "refused"
	| "blocked"
	| "malformed_call";

export interface ToolLoopResult {
	/** The text of the final tool-free turn, or "" for any other end. Only "answered" is safe to apply. */
	answer: string;
	end: ToolLoopEnd;
	history: HistoryItem[];
	usage: Usage | null;
	/** Tools that actually ran. */
	toolCallsRun: number;
	/** Model round trips made. */
	turns: number;
	/** The provider's own stop reason for the last turn, for messages. */
	providerStopReason: string | null;
}

const CUT_NOTICE = (max: number): string => `\n[AskMate cut this tool result after ${max} characters.]`;

/** Keeps a result within `max` characters including the notice, and never splits a surrogate pair. */
export function truncateResult(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}

	const notice = CUT_NOTICE(max);
	const room = Math.max(0, max - notice.length);
	const last = text.charCodeAt(room - 1);
	const cut = last >= 0xd800 && last <= 0xdbff ? room - 1 : room;
	return `${text.slice(0, Math.max(0, cut))}${notice}`;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw createAbortError();
	}
}

/** Settles with `promise`, or rejects at once if the run is stopped, even when the callee ignores the signal. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(createAbortError());
	}

	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(createAbortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		);
	});
}

interface AnsweredCall {
	result: ToolResult;
	executed: boolean;
}

async function answerCall(call: ToolCall, deps: ToolLoopDeps, limits: ToolLoopLimits, turn: number, canRun: boolean): Promise<AnsweredCall> {
	const answer = (text: string, isError: boolean, executed = false): AnsweredCall => ({
		result: { callId: call.id, name: call.name, text: truncateResult(text, limits.maxResultChars), isError },
		executed
	});

	if (call.inputError) {
		return answer(`${call.inputError} Send the arguments again as a single JSON object.`, true);
	}

	if (!deps.tools.has(call.name)) {
		return answer(`Unknown tool "${call.name}". Use only the tools you were given.`, true);
	}

	if (!canRun) {
		return answer("Not run: no more tool calls are allowed for this request. Answer with what you have.", true);
	}

	if (deps.tools.needsApproval(call) && !(await raceAbort(deps.approve(call), deps.signal))) {
		return answer("The user declined this tool call. Do not retry it; continue without it or explain what you need.", true);
	}

	throwIfAborted(deps.signal);
	deps.onProgress({ kind: "call", turn, call });

	try {
		const outcome = await raceAbort(deps.tools.run(call, deps.signal), deps.signal);
		return answer(outcome.text, outcome.isError, true);
	} catch (error) {
		if (deps.signal.aborted || isAbortError(error)) {
			throw createAbortError();
		}

		// A tool that throws still gets exactly one answer, so the model can react instead of the run failing.
		const reason = error instanceof Error ? error.message : String(error);
		return answer(`The tool failed: ${redactSecrets(reason)}`, true, true);
	}
}

function endFor(stop: TurnResult["stop"], text: string): ToolLoopEnd {
	switch (stop) {
		case "end":
			return text.trim() ? "answered" : "empty_answer";
		case "tool_calls":
			return "malformed_call";
		default:
			return stop;
	}
}

export async function runToolLoop(
	deps: ToolLoopDeps,
	initial: readonly HistoryItem[],
	limits: ToolLoopLimits = DEFAULT_TOOL_LOOP_LIMITS
): Promise<ToolLoopResult> {
	const maxTurns = Math.max(1, Math.floor(limits.maxTurns));
	const effective: ToolLoopLimits = { ...limits, maxTurns };
	const history: HistoryItem[] = [...initial];
	let usage: Usage | null = null;
	let executed = 0;
	let providerStopReason: string | null = null;

	const finish = (answer: string, end: ToolLoopEnd, turns: number): ToolLoopResult => ({
		// A cut-off, blocked, refused or limit-ended turn never yields an answer that Apply could write into a note.
		answer: end === "answered" ? answer : "",
		end,
		history,
		usage,
		toolCallsRun: executed,
		turns,
		providerStopReason
	});

	for (let turn = 1; turn <= maxTurns; turn += 1) {
		throwIfAborted(deps.signal);
		const budgetSpent = executed >= effective.maxToolCalls;
		// The last allowed turn, or one after the call budget ran out, keeps the same tools (Anthropic invalidates thinking
		// blocks if `tools` changes) but sets tool_choice none, so the model has to answer with what it has.
		const toolChoice: ToolChoice = turn < maxTurns && !budgetSpent ? "auto" : "none";

		deps.onProgress({ kind: "turn", turn, maxTurns });
		const result = await deps.sendTurn(history, toolChoice, deps.signal);
		throwIfAborted(deps.signal);
		usage = addUsage(usage, result.usage);
		providerStopReason = result.providerStopReason;

		if (result.narration) {
			deps.onProgress({ kind: "narration", turn, text: result.narration });
		}

		// Only a tool-free "end" turn is an answer. A tool_calls turn with no call in it cannot be answered or replayed.
		if (result.stop !== "tool_calls" || result.toolCalls.length === 0) {
			return finish(result.text, endFor(result.stop, result.text), turn);
		}

		history.push({ kind: "assistant", text: result.text || result.narration, toolCalls: result.toolCalls, native: result.native });

		// Sequential on purpose: tools may have side effects, and approval prompts must not stack. A model that still asks
		// for tools when none are allowed gets every call answered as not run, so nothing executes with no turn left to use it.
		const results: ToolResult[] = [];
		for (const call of result.toolCalls) {
			throwIfAborted(deps.signal);
			const canRun = toolChoice === "auto" && executed < effective.maxToolCalls;
			const answered = await answerCall(call, deps, effective, turn, canRun);
			executed += answered.executed ? 1 : 0;
			deps.onProgress({ kind: "result", turn, call, result: answered.result });
			results.push(answered.result);
		}

		// Every call gets exactly one result, in call order, even when it was declined or invalid.
		history.push({ kind: "tool_results", results });

		if (toolChoice === "none") {
			return finish("", budgetSpent ? "call_limit" : "turn_limit", turn);
		}
	}

	return finish("", "turn_limit", maxTurns);
}

/** "1 tool call" or "5 tool calls". */
function countToolCalls(count: number): string {
	return `${count} tool call${count === 1 ? "" : "s"}`;
}

/**
 * Tools can have side effects, so a run that stopped after some of them ran has to say so, and must not invite a blind
 * rerun that would repeat them. Empty when no tool ran.
 */
function describeToolsAlreadyRun(toolCallsRun: number): string {
	return toolCallsRun > 0 ? `${countToolCalls(toolCallsRun)} already ran; check what they changed before asking again.` : "";
}

/** One short explanation for the user of why a run ended without an answer. Empty for an answer. */
export function describeToolLoopEnd(result: Pick<ToolLoopResult, "end" | "toolCallsRun" | "turns" | "providerStopReason">): string {
	const reason = result.providerStopReason ? ` (${result.providerStopReason})` : "";
	const toolsRan = describeToolsAlreadyRun(result.toolCallsRun);

	switch (result.end) {
		case "answered":
			return "";
		case "empty_answer":
			return toolsRan
				? `The model finished without writing an answer. ${toolsRan}`
				: "The model finished without writing an answer. Try again, or ask for the answer directly.";
		case "turn_limit":
			return toolsRan
				? `AskMate stopped after ${result.turns} model turns without a final answer. ${toolsRan}`
				: `AskMate stopped after ${result.turns} model turns without a final answer. Ask again with a narrower request.`;
		case "call_limit":
			return `AskMate stopped after ${countToolCalls(result.toolCallsRun)}, the limit for one request. Ask again with a narrower request.`;
		case "truncated":
			return toolsRan
				? `The model's reply was cut off${reason}, so the run stopped without an answer. ${toolsRan}`
				: `The model's reply was cut off${reason}, so no tool was run and there is no answer. Ask for a shorter result or split the request.`;
		case "refused":
			return toolsRan ? `The model declined to answer${reason}. ${toolsRan}` : `The model declined to answer${reason}.`;
		case "blocked":
			return `The provider blocked this reply${reason}. ${toolsRan ? `${toolsRan} ` : ""}Rephrase the request or reduce the note context.`;
		case "malformed_call":
			return toolsRan
				? `The model sent a tool call AskMate could not read${reason}. ${toolsRan}`
				: `The model sent a tool call AskMate could not read${reason}. Try again.`;
	}
}
