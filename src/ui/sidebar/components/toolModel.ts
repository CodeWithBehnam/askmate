import type { SavedToolCall, SavedToolStatus } from "../../../threads/threadModel";
import type { ToolApprovalCard, ToolUiEvent, ToolUiStatus } from "../../../requests/runTypes";

/** Pure rules for the tool-call cards: wording, ordering of updates, and what a saved conversation keeps. */

export const MAX_RESULT_PREVIEW_CHARACTERS = 600;

export function toolStatusText(status: ToolUiStatus): string {
	switch (status) {
		case "pending-approval":
			return "Waiting for your approval";
		case "running":
			return "Running";
		case "done":
			return "Done";
		case "error":
			return "Failed";
		case "denied":
			return "Denied";
	}
}

export function isFinalToolStatus(status: ToolUiStatus): boolean {
	return status === "done" || status === "error" || status === "denied";
}

/**
 * Control, format (zero-width and bidirectional) and line or paragraph separator characters, plus the tag block. The
 * same invisible and direction-changing characters the write path removes from model text; here they are shown, not
 * removed, because what the person approves must stay complete.
 */
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u180E\u{E0000}-\u{E007F}]/gu;
const LAYOUT_CHARACTERS = new Set(["\n", "\r", "\t"]);

/**
 * Writes every invisible or direction-changing character as a visible \uXXXX sequence. Tool names, titles and
 * arguments come from a model and a server, either of which can hide a character that makes one thing read as another
 * (a right-to-left override in a file name, a zero-width space in a command). Line breaks and tabs stay.
 */
export function showHiddenCharacters(text: string): string {
	return text.replace(HIDDEN_CHARACTERS, (char) => {
		if (LAYOUT_CHARACTERS.has(char)) {
			return char;
		}
		const code = char.codePointAt(0) ?? 0;
		const hex = code.toString(16).toUpperCase();
		return code > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
	});
}

export function toolCardName(event: Pick<ToolUiEvent, "server" | "tool">): string {
	return showHiddenCharacters(event.server ? `${event.server}: ${event.tool}` : event.tool);
}

/**
 * The header while a call waits for approval. A server may supply a friendlier title, but the name that will run is
 * always shown with it, so a title can never stand in for the tool.
 */
export function approvalCardName(request: Pick<ToolApprovalCard, "server" | "tool" | "title">): string {
	const title = (request.title ?? "").replace(/\s+/g, " ").trim();
	const label = title && title !== request.tool ? `${title} (${request.tool})` : request.tool;
	return showHiddenCharacters(request.server ? `${request.server}: ${label}` : label);
}

/**
 * Arguments exactly as the tool will receive them, pretty printed when they are JSON, with hidden characters made
 * visible. They are never shortened: what the person approves must be what is sent.
 */
export function formatToolArguments(argumentsJson: string): string {
	const raw = argumentsJson.trim();
	if (!raw) {
		return "{}";
	}
	try {
		return showHiddenCharacters(JSON.stringify(JSON.parse(raw), null, 2));
	} catch {
		return showHiddenCharacters(raw);
	}
}

/** A tool result for display. It is text from outside AskMate, so it is shown as plain text and kept short. */
export function previewToolResult(text: string, max = MAX_RESULT_PREVIEW_CHARACTERS): string {
	const plain = text.replace(/\r\n?/g, "\n").trim();
	return plain.length > max ? `${plain.slice(0, max).trimEnd()}...` : plain;
}

/** Applies an update to the list of calls in the order they first appeared. A final status is never undone by a late event. */
export function mergeToolEvent(events: readonly ToolUiEvent[], event: ToolUiEvent): ToolUiEvent[] {
	const index = events.findIndex((candidate) => candidate.id === event.id);
	if (index < 0) {
		return [...events, event];
	}
	const current = events[index];
	if (current && isFinalToolStatus(current.status) && !isFinalToolStatus(event.status)) {
		return [...events];
	}
	return events.map((candidate, position) => (position === index ? { ...candidate, ...event } : candidate));
}

function savedStatus(status: ToolUiStatus): SavedToolStatus {
	if (status === "done") {
		return "completed";
	}
	return status === "denied" ? "denied" : "failed";
}

/** What a saved conversation keeps about tool calls: names, outcome and a line. Arguments and raw results are never stored. */
export function summariseToolCalls(events: readonly ToolUiEvent[]): SavedToolCall[] {
	return events.map((event) => {
		const line = event.error ?? event.resultPreview ?? "";
		const summary = previewToolResult(line, 300).replace(/\s+/g, " ");
		return {
			server: event.server,
			tool: event.tool,
			status: savedStatus(event.status),
			...(summary ? { summary } : {})
		};
	});
}

export function describeSavedToolCall(call: SavedToolCall): string {
	const outcome = call.status === "completed" ? "used" : call.status === "denied" ? "was denied" : "failed";
	return `${toolCardName(call)} ${outcome}${call.summary ? `: ${call.summary}` : ""}`;
}
