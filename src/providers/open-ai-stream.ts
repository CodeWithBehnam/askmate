/**
 * Quarantined OpenAI Responses SSE helpers.
 *
 * Live AskMate text path uses one-shot JSON via `requestOpenAIResponses` (Obsidian
 * `requestUrl` does not expose a cancelable SSE body). Keep these helpers for a
 * future streaming implementation; do not call them from production request paths
 * until true streaming is wired.
 */
import type { OpenAIStreamEvent, OpenAITokenUsage } from "../shared/core";

export function parseOpenAIStreamEvent(line: string): OpenAIStreamEvent | null {
	if (!line.startsWith("data: ")) {
		return null;
	}

	const payload = line.slice(6).trim();

	if (!payload || payload === "[DONE]") {
		return null;
	}

	try {
		const event = JSON.parse(payload) as OpenAIStreamEvent;

		if (event.error?.message) {
			throw new Error(event.error.message);
		}

		return event;
	} catch (error) {
		if (error instanceof Error) {
			throw error;
		}
	}

	return null;
}

export function getOpenAIStreamDelta(event: OpenAIStreamEvent): string {
	if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
		return event.delta;
	}

	return "";
}

export function getOpenAIStreamUsage(event: OpenAIStreamEvent): OpenAITokenUsage | null {
	return event.response?.usage ?? event.usage ?? null;
}

export function isCompletedOpenAIStreamEvent(event: OpenAIStreamEvent): boolean {
	return event.type === "response.completed" || event.response?.status === "completed";
}

export function getOpenAIStreamTerminalError(event: OpenAIStreamEvent): string | null {
	const responseError = event.response?.error?.message?.trim();

	if (responseError) {
		return responseError;
	}

	if (event.type === "response.failed" || event.response?.status === "failed") {
		return "OpenAI response failed.";
	}

	if (event.type === "response.incomplete" || event.response?.status === "incomplete") {
		const reason = event.response?.incomplete_details?.reason?.trim();
		return reason ? `OpenAI response incomplete: ${reason}.` : "OpenAI response incomplete.";
	}

	return null;
}
