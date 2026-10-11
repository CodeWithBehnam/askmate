/** Pure Server-Sent Events parsing. Network and decoding live in sseTransport.ts. */

export interface SseEvent {
	/** The `event:` field, or "message" when the server sent none. */
	event: string;
	/** Multi-line `data:` fields joined with a newline, as the SSE specification defines. */
	data: string;
}

export interface SseParserState {
	/** Text of an event that has not seen its terminating blank line yet. */
	readonly pending: string;
}

export const INITIAL_SSE_STATE: SseParserState = { pending: "" };

function parseSseBlock(block: string): SseEvent | null {
	let event = "";
	const dataLines: string[] = [];

	for (const line of block.split("\n")) {
		if (!line || line.startsWith(":")) {
			continue;
		}

		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		const rawValue = colon === -1 ? "" : line.slice(colon + 1);
		const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

		if (field === "event") {
			event = value;
		} else if (field === "data") {
			dataLines.push(value);
		}
	}

	return dataLines.length > 0 ? { event: event || "message", data: dataLines.join("\n") } : null;
}

/** Feeds decoded text and returns the events completed by it. Handles LF, CRLF and CR line endings across chunk boundaries. */
export function feedSse(state: SseParserState, chunk: string): { state: SseParserState; events: SseEvent[] } {
	const combined = state.pending + chunk;
	// A trailing CR may be the first half of a CRLF split across chunks, so it waits for the next chunk.
	const heldCr = combined.endsWith("\r") ? "\r" : "";
	const normalised = combined.slice(0, combined.length - heldCr.length).replace(/\r\n?/g, "\n");
	const boundary = normalised.lastIndexOf("\n\n");

	if (boundary === -1) {
		return { state: { pending: normalised + heldCr }, events: [] };
	}

	const events = normalised
		.slice(0, boundary)
		.split("\n\n")
		.map(parseSseBlock)
		.filter((event): event is SseEvent => event !== null);

	return { state: { pending: normalised.slice(boundary + 2) + heldCr }, events };
}

/**
 * Dispatches an unterminated final event. The specification discards it, but some servers close the
 * connection without the last blank line, and that event is often the one carrying usage or the finish reason.
 */
export function flushSse(state: SseParserState): SseEvent[] {
	const block = state.pending.replace(/\r\n?/g, "\n");
	const event = parseSseBlock(block);
	return event ? [event] : [];
}
