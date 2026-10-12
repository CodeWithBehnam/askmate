/**
 * The prompt inspector shows the instructions and the message the request builders produce. A run adds two things after
 * that, once it knows more than the request does: the diagram brief (it needs the Mermaid runtime to know which diagram types
 * can be drawn) and the tools section (it needs the tools the servers offer). The inspector cannot build either without
 * starting that work, so it says they are missing and counts a fixed allowance for them. Pure.
 */
import type { PromptInspection } from "../shared/types";

/** A diagram brief (look, type line, size rule, role list and tagging) measured about 260 tokens, so this leaves some room. */
export const DIAGRAM_BRIEF_TOKEN_ALLOWANCE = 400;
/** The tools section names the tool count, the call limit and the approval rule; it does not list the tools. */
export const TOOLS_SECTION_TOKEN_ALLOWANCE = 200;

/** An inspection that also says what the run adds after the text shown. */
export interface InspectedPrompt extends PromptInspection {
	/** One sentence per part the run adds when it sends the request. Empty when the text shown is everything. */
	addedAtSend: readonly string[];
}

export interface AddedAtSend {
	notes: string[];
	/** Tokens to count on top of the text shown. */
	extraTokens: number;
}

export function describeAddedAtSend(input: { isDiagram: boolean; toolsAvailable: boolean }): AddedAtSend {
	const notes: string[] = [];
	let extraTokens = 0;
	if (input.isDiagram) {
		notes.push("The diagram brief (look, diagram type, size rule and node roles) is added after the final prompt when the request is sent.");
		extraTokens += DIAGRAM_BRIEF_TOKEN_ALLOWANCE;
	}
	if (input.toolsAvailable) {
		notes.push("When the answer can use MCP tools, a short tools section (tool count, call limit and approval rule) is added to the instructions when the request is sent.");
		extraTokens += TOOLS_SECTION_TOKEN_ALLOWANCE;
	}
	return { notes, extraTokens };
}
