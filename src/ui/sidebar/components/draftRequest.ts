import { DEFAULT_IMAGE_PROMPT } from "../../../settings/constants";
import type { RunRequestOptions, Workflow } from "../../../shared/types";
import { parseConsoleInput, type ConsoleAction, type ConsoleCommand, type ConsoleMentions } from "../consoleCommands";
import { DEFAULT_DIAGRAM_QUESTION, MERMAID_SKILL_ID } from "./diagramModel";

/**
 * What the composer would send for the text in it. The request preview and Inspect prompt both read this, so they
 * describe the request that Enter would really start, including workflow commands. A line that is a command and not a
 * request (for example /model) resolves to a neutral hint, because there is nothing to build for it.
 *
 * Slash commands and @mentions work in every layout. Outside the Console a line with neither is a plain question and is
 * read exactly as it always was.
 */

export type DraftRequestKind = "answer" | "image" | "workflow" | "diagram" | "inspect";

export type DraftResolution =
	| {
		kind: "request";
		draftKind: DraftRequestKind;
		question: string;
		title: string;
		forceImage: boolean;
		options: RunRequestOptions;
		/** Skills the line names (@skill:name or /skill name question). Whether they exist is for the skill service. */
		skillNames: string[];
	}
	| { kind: "none"; hint: string };

export interface DraftDeps {
	isConsole: boolean;
	commands: readonly ConsoleCommand[];
	/** The options the composer would send before any command changes them. */
	baseOptions(forceImage: boolean): RunRequestOptions;
	/** Reads @mentions against the vault. May throw for a mention that cannot be honoured. */
	applyMentions(options: RunRequestOptions, mentions: ConsoleMentions): RunRequestOptions;
	findWorkflow(id: string): Workflow | undefined;
	workflowPrompt(workflow: Workflow): string;
}

export const COMMAND_HINT = "This is a command, not a question. Press Enter to run it.";
const IMAGE_COMMAND = /^\/(?:image|img)\b\s*/i;

export function parsePlainComposerCommand(value: string): { question: string; forceImage: boolean } {
	const imageMatch = IMAGE_COMMAND.exec(value);
	return imageMatch
		? { question: value.slice(imageMatch[0].length).trim() || DEFAULT_IMAGE_PROMPT, forceImage: true }
		: { question: value, forceImage: false };
}

/** A line read for the layouts that keep a plain question plain: the question as it goes to the model, or the command to run. */
export type ComposerLine =
	| { kind: "plain"; question: string; forceImage: boolean }
	| { kind: "command"; action: ConsoleAction };

function hasMentions(mentions: ConsoleMentions): boolean {
	return mentions.scope !== "auto" || mentions.folder !== null || mentions.notes.length > 0 || mentions.vault.length > 0 || mentions.skills.length > 0;
}

/**
 * Reads a line from the composer. A line with no command, no @mention, no mode prefix and no "//" escape is a plain
 * question, and so is "/image ..." (including a bare "/image", which asks for the default picture); everything else is a
 * command line for the Console parser. The parser leaves an unknown @word such as an email address alone, so ordinary
 * prose stays prose.
 */
export function readComposerLine(raw: string, commands: readonly ConsoleCommand[]): ComposerLine {
	const trimmed = raw.trim();
	const action = parseConsoleInput(trimmed, commands);
	if (action.kind === "ask" && !action.literal && action.outputMode === null && !hasMentions(action.mentions)) {
		return { kind: "plain", question: action.question, forceImage: false };
	}
	const imageLine = IMAGE_COMMAND.test(trimmed);
	if (imageLine && ((action.kind === "image" && !hasMentions(action.mentions)) || (action.kind === "error" && /^\/(?:image|img)$/i.test(trimmed)))) {
		return { kind: "plain", ...parsePlainComposerCommand(trimmed) };
	}
	return { kind: "command", action };
}

function plain(line: Extract<ComposerLine, { kind: "plain" }>, deps: DraftDeps): DraftResolution {
	return {
		kind: "request",
		draftKind: line.forceImage ? "image" : "answer",
		question: line.question,
		title: line.forceImage ? "AskMate Image" : "AskMate Answer",
		forceImage: line.forceImage,
		options: deps.baseOptions(line.forceImage),
		skillNames: []
	};
}

export function resolveDraftRequest(raw: string, deps: DraftDeps): DraftResolution {
	try {
		// The Console reads every line as a command line, which keeps its preview identical to what it sends.
		const line = deps.isConsole ? null : readComposerLine(raw, deps.commands);
		if (line?.kind === "plain") {
			return plain(line, deps);
		}
		const action = line?.kind === "command" ? line.action : parseConsoleInput(raw, deps.commands);
		switch (action.kind) {
			case "ask": {
				const draft = deps.baseOptions(false);
				const withMode = action.outputMode ? { ...draft, outputMode: action.outputMode } : draft;
				const options = deps.applyMentions(action.literal ? { ...withMode, intentKind: "freeform_text" } : withMode, action.mentions);
				return { kind: "request", draftKind: "answer", question: action.question, title: "AskMate Answer", forceImage: false, options, skillNames: action.mentions.skills };
			}
			case "image":
				return {
					kind: "request",
					draftKind: "image",
					question: action.prompt,
					title: "AskMate Image",
					forceImage: true,
					options: deps.applyMentions(deps.baseOptions(true), action.mentions),
					skillNames: []
				};
			case "inspect":
				return {
					kind: "request",
					draftKind: "inspect",
					question: action.question || "Preview request",
					title: "AskMate Answer",
					forceImage: false,
					options: deps.applyMentions(deps.baseOptions(false), action.mentions),
					skillNames: action.mentions.skills
				};
			case "workflow": {
				const workflow = deps.findWorkflow(action.workflowId);
				if (!workflow) {
					return { kind: "none", hint: "That workflow no longer exists. Type /help to see the current list." };
				}
				const options = deps.applyMentions({ ...deps.baseOptions(false), workflow, workflowExtra: action.extra || undefined }, action.mentions);
				return { kind: "request", draftKind: "workflow", question: deps.workflowPrompt(workflow), title: workflow.name, forceImage: false, options, skillNames: action.mentions.skills };
			}
			case "diagram": {
				const options = deps.applyMentions({ ...deps.baseOptions(false), intentKind: "diagram" }, action.mentions);
				return {
					kind: "request",
					draftKind: "diagram",
					question: action.prompt || DEFAULT_DIAGRAM_QUESTION,
					title: "AskMate Diagram",
					forceImage: false,
					options,
					skillNames: [MERMAID_SKILL_ID, ...action.mentions.skills]
				};
			}
			case "skill": {
				if (!action.question) {
					return { kind: "none", hint: `Press Enter to keep the ${action.name} skill on for this conversation.` };
				}
				const options = deps.applyMentions(deps.baseOptions(false), action.mentions);
				return { kind: "request", draftKind: "answer", question: action.question, title: "AskMate Answer", forceImage: false, options, skillNames: [action.name, ...action.mentions.skills] };
			}
			case "error":
				return { kind: "none", hint: action.message };
			default:
				return { kind: "none", hint: COMMAND_HINT };
		}
	} catch (error) {
		// A mention that cannot be read is reported when the user sends; the preview says so in the same words.
		return { kind: "none", hint: error instanceof Error ? error.message : COMMAND_HINT };
	}
}
