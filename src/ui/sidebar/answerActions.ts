/** Pure rules for the Copy and Insert at cursor message actions. */
import type { ChatMessage } from "../../shared/types";

export interface LastAnswer {
	/** The raw model text, not the sanitised rendering. */
	text: string;
	incompleteReason: string | null;
}

/** Saved threads keep only an incomplete flag, not the provider's reason. */
export const SAVED_INCOMPLETE_REASON = "saved_incomplete";

export function describeIncompleteReason(reason: string): string {
	const normalized = reason.toLowerCase();
	if (normalized === "stream_interrupted") {
		return "the connection ended before the reply finished";
	}
	if (normalized === SAVED_INCOMPLETE_REASON) {
		return "it was marked incomplete when it was saved";
	}
	if (/max_tokens|max_output_tokens|length|token/.test(normalized)) {
		return "the provider stopped at its output token limit";
	}
	if (/refusal|content_filter|safety|blocked|recitation|prohibited/.test(normalized)) {
		return "the provider refused or filtered part of the answer";
	}
	return `the provider reported "${reason}"`;
}

/** Drops blank lines around the reply so inserting mid-note does not add stray gaps. */
export function prepareInsertText(text: string): string {
	return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
}

export function formatInsertNotice(answer: LastAnswer): string {
	return answer.incompleteReason
		? `Inserted at cursor. This reply may be incomplete: ${describeIncompleteReason(answer.incompleteReason)}.`
		: "Inserted at cursor.";
}

/** The newest text reply in a restored conversation, so Copy and Insert commands match what the sidebar shows. */
export function lastAnswerFromMessages(messages: readonly ChatMessage[]): LastAnswer | null {
	const reply = [...messages].reverse().find((message) => message.role === "assistant" && !message.image && message.text.trim().length > 0);
	return reply ? { text: reply.text, incompleteReason: reply.incomplete ? SAVED_INCOMPLETE_REASON : null } : null;
}

export function isInsertable(answer: LastAnswer | null): answer is LastAnswer {
	return answer !== null && prepareInsertText(answer.text).length > 0;
}
