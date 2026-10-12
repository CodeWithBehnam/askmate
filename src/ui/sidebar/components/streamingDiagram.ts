import { splitUnclosedMermaid } from "../../../safety/sanitize";

/**
 * Streaming and diagrams. Re-rendering a whole reply every 120 ms makes Mermaid draw a half-written diagram, fail,
 * and flash an error. While a diagram fence is still open the reply is rendered up to the fence and a placeholder
 * stands in for the rest; the diagram is drawn once, when its closing line arrives.
 */

export interface StreamRenderPlan {
	/** The part of the reply that is safe to render now. */
	settled: string;
	/** True while a diagram is still being written. */
	drawing: boolean;
	/** True when a diagram is already complete in the settled text, which makes every redraw expensive. */
	hasDiagram: boolean;
}

export const STREAM_RENDER_MS = 120;
/** A reply holding a finished diagram redraws it on every render, so it is redrawn less often. */
export const DIAGRAM_STREAM_RENDER_MS = 800;
export const DRAWING_DIAGRAM_TEXT = "Drawing the diagram...";

const MERMAID_HINT = /mermaid|mmd/i;
const CLOSED_FENCE = /(^|\n)[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*(?:mermaid|mmd)\b[^\n]*\n[\s\S]*?\n[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*(?:\n|$)/i;

export function planStreamRender(markdown: string): StreamRenderPlan {
	if (!MERMAID_HINT.test(markdown)) {
		return { settled: markdown, drawing: false, hasDiagram: false };
	}
	const split = splitUnclosedMermaid(markdown);
	return {
		settled: split.settled,
		drawing: split.pendingSource !== null,
		hasDiagram: CLOSED_FENCE.test(split.settled)
	};
}

/** True when there is nothing new to draw: same settled text as the last render. */
export function isRenderCurrent(plan: StreamRenderPlan, lastSettled: string | undefined): boolean {
	return lastSettled !== undefined && plan.settled === lastSettled;
}

export function streamRenderDelay(plan: StreamRenderPlan): number {
	return plan.hasDiagram ? DIAGRAM_STREAM_RENDER_MS : STREAM_RENDER_MS;
}
