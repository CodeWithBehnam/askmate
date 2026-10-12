import { describeIncompleteReason } from "./answerActions";

/**
 * Text for the one status element that screen readers hear. Streamed replies are kept out of live regions because
 * they would be read word by word; instead the view announces a single sentence when a run ends. Obsidian Notices are
 * silent to assistive technology, so the same builder also mirrors a Notice into that element.
 */

export type AnnouncementEvent =
	| { kind: "started" }
	| {
		kind: "completed";
		/** The finished reply. Only its length is announced, never its content. */
		text?: string;
		/** True for a generated image, which has no text to count. */
		image?: boolean;
		incompleteReason?: string | null;
		/** A diagram was drawn in the reply. */
		diagram?: boolean;
		toolCalls?: number;
		/** Where the reply went when it was not just shown in the sidebar. */
		saved?: { kind: "note" | "applied"; label: string };
	}
	| { kind: "failed"; message: string }
	| { kind: "stopped"; partial: boolean }
	| { kind: "approval"; toolName: string; serverName?: string }
	| { kind: "notice"; message: string };

const MAX_MESSAGE_LENGTH = 200;

/** Words in the text, counted by script rules where the runtime supports them so Chinese and Japanese are not one word. */
export function countWords(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) {
		return 0;
	}
	if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
		let count = 0;
		for (const segment of new Intl.Segmenter(undefined, { granularity: "word" }).segment(trimmed)) {
			if (segment.isWordLike) {
				count += 1;
			}
		}
		return count;
	}
	return trimmed.split(/\s+/).length;
}

function roughly(count: number): string {
	if (count < 100) {
		return `${count} ${count === 1 ? "word" : "words"}`;
	}
	return `about ${Math.round(count / 10) * 10} words`;
}

function oneLine(message: string): string {
	const plain = message.replace(/\s+/g, " ").trim();
	return plain.length > MAX_MESSAGE_LENGTH ? `${plain.slice(0, MAX_MESSAGE_LENGTH)}...` : plain;
}

function endWithStop(sentence: string): string {
	return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

export function describeAnnouncement(event: AnnouncementEvent): string {
	switch (event.kind) {
		case "started":
			return "AskMate is working.";
		case "completed": {
			const parts: string[] = [];
			if (event.image) {
				parts.push("AskMate finished generating the image.");
			} else if (event.diagram) {
				parts.push("AskMate finished a reply with a diagram.");
			} else {
				const words = countWords(event.text ?? "");
				parts.push(words > 0 ? `AskMate finished a reply of ${roughly(words)}.` : "AskMate finished.");
			}
			if (event.toolCalls && event.toolCalls > 0) {
				parts.push(`${event.toolCalls} ${event.toolCalls === 1 ? "tool call was" : "tool calls were"} used.`);
			}
			if (event.saved) {
				parts.push(endWithStop(event.saved.kind === "note" ? `Saved to ${oneLine(event.saved.label)}` : oneLine(event.saved.label)));
			}
			if (event.incompleteReason) {
				parts.push(`The reply may be incomplete because ${describeIncompleteReason(event.incompleteReason)}.`);
			}
			return parts.join(" ");
		}
		case "failed":
			return endWithStop(`AskMate could not finish: ${oneLine(event.message)}`);
		case "stopped":
			return event.partial ? "AskMate stopped. The partial reply was not saved." : "AskMate stopped.";
		case "approval":
			return `AskMate needs your approval to run ${event.toolName}${event.serverName ? ` on ${event.serverName}` : ""}.`;
		case "notice":
			return oneLine(event.message);
	}
}
