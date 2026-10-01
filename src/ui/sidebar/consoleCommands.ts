import type { ComposerLayout, ContextScope, OutputMode, ReasoningEffort, Workflow } from "../../shared/types";

/**
 * Pure command language for the Console sidebar layout: slash commands, @mentions, completion, help and the status line.
 * The view only wires these to Obsidian, so every rule here is unit tested.
 */

export type ConsoleCommandKind =
	| "workflow"
	| "mode"
	| "image"
	| "effort"
	| "layout"
	| "clear"
	| "help"
	| "context"
	| "inspect"
	| "history";

export interface ConsoleCommand {
	/** Typed after the slash, lower case. */
	name: string;
	aliases: string[];
	summary: string;
	kind: ConsoleCommandKind;
	argumentHint?: string;
	workflowId?: string;
	outputMode?: OutputMode;
}

export interface ConsoleMentions {
	scope: ContextScope;
	/** null when @folder was not used; "" for the folder configured in settings; otherwise the folder typed after @folder:. */
	folder: string | null;
	/** Extra notes added with @[[Note]]. */
	notes: string[];
}

export type ConsoleAction =
	/** literal: the line started with "//", so the question is sent as typed and never treated as an image command. */
	| { kind: "ask"; question: string; outputMode: OutputMode | null; mentions: ConsoleMentions; literal: boolean }
	| { kind: "image"; prompt: string; mentions: ConsoleMentions }
	| { kind: "workflow"; workflowId: string; extra: string; mentions: ConsoleMentions }
	| { kind: "mode"; mode: OutputMode }
	| { kind: "effort"; effort: ReasoningEffort | null }
	| { kind: "layout"; layout: ComposerLayout }
	| { kind: "clear" }
	| { kind: "help" }
	| { kind: "context"; mentions: ConsoleMentions }
	| { kind: "inspect"; question: string; mentions: ConsoleMentions }
	| { kind: "history" }
	| { kind: "error"; message: string };

export interface ConsoleCompletion {
	label: string;
	insertText: string;
	detail: string;
}

export interface ConsoleCompletionResult {
	/** Index in the input where the replaced token starts. */
	from: number;
	/** Index in the input where the replaced token ends. */
	to: number;
	items: ConsoleCompletion[];
}

export interface ConsoleStatusSegment {
	kind: "mode" | "model" | "effort" | "usage";
	text: string;
	title: string;
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];
// A Map, so names such as "constructor" never match an inherited object key.
const LAYOUT_NAMES = new Map<string, ComposerLayout>([
	["console", "console"],
	["compact", "compact"],
	["standard", "compact"],
	["expanded", "expanded"]
]);

export function resolveLayoutName(name: string): ComposerLayout | null {
	return LAYOUT_NAMES.get(name.trim().toLowerCase()) ?? null;
}
const MAX_COMPLETIONS = 8;

const BUILT_IN_COMMANDS: ConsoleCommand[] = [
	{ name: "help", aliases: ["?", "commands"], summary: "List commands, workflows and mentions", kind: "help" },
	{ name: "chat", aliases: [], summary: "Answer in this sidebar (with text: one question only)", kind: "mode", outputMode: "chat", argumentHint: "[question]" },
	{ name: "note", aliases: ["new-note"], summary: "Save answers as new notes (with text: one question only)", kind: "mode", outputMode: "note", argumentHint: "[question]" },
	{ name: "apply", aliases: [], summary: "Write answers into the note (with text: one question only)", kind: "mode", outputMode: "apply", argumentHint: "[question]" },
	{ name: "image", aliases: ["img"], summary: "Generate an image with OpenAI Images", kind: "image", argumentHint: "<prompt>" },
	{ name: "effort", aliases: ["reasoning"], summary: "Set reasoning effort: none, low, medium, high, xhigh", kind: "effort", argumentHint: "<level>" },
	{ name: "context", aliases: ["ctx"], summary: "Show what the next request would send", kind: "context" },
	{ name: "inspect", aliases: ["prompt"], summary: "Open the final prompt for a question", kind: "inspect", argumentHint: "[question]" },
	{ name: "history", aliases: [], summary: "Show AskMate history for this note", kind: "history" },
	{ name: "clear", aliases: ["cls"], summary: "Clear the conversation", kind: "clear" },
	{ name: "layout", aliases: [], summary: "Switch layout: console, compact, expanded", kind: "layout", argumentHint: "<layout>" }
];

export function slugifyCommandName(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Built-in commands followed by one command per workflow, named after its short name and falling back to its id. */
export function buildConsoleCommands(workflows: readonly Workflow[]): ConsoleCommand[] {
	const taken = new Set(BUILT_IN_COMMANDS.flatMap((command) => [command.name, ...command.aliases]));
	const workflowCommands: ConsoleCommand[] = [];
	for (const workflow of workflows) {
		const preferred = slugifyCommandName(workflow.shortName);
		const fallback = slugifyCommandName(workflow.id);
		const name = preferred && !taken.has(preferred) ? preferred : fallback;
		if (!name || taken.has(name)) {
			continue;
		}
		taken.add(name);
		const aliases = [fallback, slugifyCommandName(workflow.name)].filter((alias) => alias && !taken.has(alias));
		aliases.forEach((alias) => taken.add(alias));
		workflowCommands.push({
			name,
			aliases: Array.from(new Set(aliases)),
			summary: workflow.name === workflow.description ? workflow.name : `${workflow.name}: ${workflow.description}`,
			kind: "workflow",
			workflowId: workflow.id,
			argumentHint: "[extra instructions]"
		});
	}
	return [...BUILT_IN_COMMANDS, ...workflowCommands];
}

function findCommand(name: string, commands: readonly ConsoleCommand[]): { command: ConsoleCommand | null; candidates: ConsoleCommand[] } {
	const exact = commands.find((command) => command.name === name || command.aliases.includes(name));
	if (exact) {
		return { command: exact, candidates: [exact] };
	}
	// A unique prefix runs the command, so "/pol" works like "/polish".
	const byPrefix = commands.filter((command) => command.name.startsWith(name) || command.aliases.some((alias) => alias.startsWith(name)));
	return { command: byPrefix.length === 1 ? byPrefix[0] : null, candidates: byPrefix };
}

// A mention may be followed by closing punctuation ("Summarise @note."); a bare folder name never ends with it.
const MENTION_PATTERN = /(^|\s)@(?:\[\[([^\]\n]+)\]\]|(selection|sel|note|folder)(?::(?:"([^"\n]+)"|(\S*[^\s.,;:!?)])))?)(?=[\s.,;:!?)]|$)/gi;
const REMOVED_MENTION = "\u0000";

/** Removes @mentions from the input. Unknown @words (such as email addresses) are left alone. */
export function extractConsoleMentions(input: string): { text: string; mentions: ConsoleMentions; error: string | null } {
	const mentions: ConsoleMentions = { scope: "auto", folder: null, notes: [] };
	const scopes = new Set<ContextScope>();
	let error: string | null = null;

	const marked = input.replace(MENTION_PATTERN, (match: string, lead: string, note?: string, keyword?: string, quoted?: string, bare?: string) => {
		if (note) {
			// Only the note itself is attached; an alias, heading or block reference does not change which note that is.
			const target = note.split("|")[0].split(/[#^]/)[0].trim();
			if (target && !mentions.notes.includes(target)) {
				mentions.notes.push(target);
			}
			return `${lead}${REMOVED_MENTION}`;
		}
		const name = (keyword ?? "").toLowerCase();
		const argument = (quoted ?? bare ?? "").trim();
		if (name === "folder") {
			mentions.folder = argument;
			return `${lead}${REMOVED_MENTION}`;
		}
		if (argument) {
			// "@note:Something" is not a mention form; keep it as typed.
			return match;
		}
		scopes.add(name === "note" ? "note" : "selection");
		return `${lead}${REMOVED_MENTION}`;
	});
	// Tidy only where a mention was removed, so indentation, tables and pasted code keep their spacing.
	const text = marked
		.replace(/[ \t]*\u0000[ \t]*(?=[.,;:!?)\r\n]|$)/g, "")
		.replace(/[ \t]*\u0000[ \t]*/g, " ")
		.trim();

	if (scopes.size > 1) {
		error = "Use either @selection or @note, not both.";
	} else if (scopes.size === 1) {
		mentions.scope = scopes.has("note") ? "note" : "selection";
	}
	return { text, mentions, error };
}

export function parseConsoleInput(raw: string, commands: readonly ConsoleCommand[]): ConsoleAction {
	const extracted = extractConsoleMentions(raw.trim());
	if (extracted.error) {
		return { kind: "error", message: extracted.error };
	}
	const { mentions } = extracted;
	let text = extracted.text;

	if (!text) {
		return { kind: "error", message: raw.trim() ? "Add a question after the mentions." : "Type a question, or /help for commands." };
	}
	// "//text" sends a question that starts with a slash.
	if (text.startsWith("//")) {
		return { kind: "ask", question: text.slice(1), outputMode: null, mentions, literal: true };
	}
	if (!text.startsWith("/")) {
		return { kind: "ask", question: text, outputMode: null, mentions, literal: false };
	}

	const match = text.match(/^\/(\S*)\s*([\s\S]*)$/);
	const name = (match?.[1] ?? "").toLowerCase();
	const argument = (match?.[2] ?? "").trim();
	if (!name) {
		return { kind: "error", message: "Type a command after the slash, or /help to list them." };
	}
	const { command, candidates } = findCommand(name, commands);
	if (!command) {
		return candidates.length > 1
			? { kind: "error", message: `/${name} could mean ${candidates.slice(0, 6).map((candidate) => `/${candidate.name}`).join(", ")}${candidates.length > 6 ? " and more" : ""}. Type more of the name.` }
			: { kind: "error", message: `Unknown command /${name}. Type /help to list commands, or start with // to send it as text.` };
	}
	text = argument;

	switch (command.kind) {
		case "workflow":
			return command.workflowId
				? { kind: "workflow", workflowId: command.workflowId, extra: text, mentions }
				: { kind: "error", message: `/${command.name} has no workflow.` };
		case "mode": {
			const mode = command.outputMode ?? "chat";
			return text ? { kind: "ask", question: text, outputMode: mode, mentions, literal: false } : { kind: "mode", mode };
		}
		case "image":
			return text ? { kind: "image", prompt: text, mentions } : { kind: "error", message: "Describe the image after /image, for example /image a lighthouse at dusk." };
		case "effort": {
			if (!text) {
				return { kind: "effort", effort: null };
			}
			const effort = REASONING_EFFORTS.find((value) => value === text.toLowerCase());
			return effort ? { kind: "effort", effort } : { kind: "error", message: `Unknown effort "${text}". Use one of: ${REASONING_EFFORTS.join(", ")}.` };
		}
		case "layout": {
			const layout = resolveLayoutName(text);
			return layout ? { kind: "layout", layout } : { kind: "error", message: "Use /layout console, /layout compact or /layout expanded." };
		}
		case "clear":
			return { kind: "clear" };
		case "help":
			return { kind: "help" };
		case "context":
			return { kind: "context", mentions };
		case "inspect":
			return { kind: "inspect", question: text, mentions };
		case "history":
			return { kind: "history" };
	}
}

function rankMatches<T>(items: readonly T[], query: string, keys: (item: T) => string[]): T[] {
	const score = (item: T): number => {
		const values = keys(item);
		if (values[0].startsWith(query)) {
			return 0;
		}
		if (values.some((value) => value.startsWith(query))) {
			return 1;
		}
		return values.some((value) => value.includes(query)) ? 2 : 3;
	};
	return items
		.map((item, index) => ({ item, index, rank: score(item) }))
		.filter((entry) => entry.rank < 3)
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.item);
}

const MENTION_COMPLETIONS: ConsoleCompletion[] = [
	{ label: "@selection", insertText: "@selection ", detail: "Only the selected text; stops if nothing is selected" },
	{ label: "@note", insertText: "@note ", detail: "The whole note, even when text is selected" },
	{ label: "@folder", insertText: "@folder ", detail: "Notes in the folder set in AskMate settings" },
	{ label: "@folder:", insertText: "@folder:", detail: "Notes in a folder you name, for example @folder:Projects" },
	{ label: "@[[", insertText: "@[[", detail: "Add another note, for example @[[Vendors]]" }
];

/** Suggestions for the token before the cursor: a command at the start, or an @mention anywhere. */
export function getConsoleCompletions(input: string, cursor: number, commands: readonly ConsoleCommand[]): ConsoleCompletionResult {
	const before = input.slice(0, cursor);
	const commandMatch = before.match(/^\/([^\s]*)$/);
	if (commandMatch) {
		const query = commandMatch[1].toLowerCase();
		const matches = rankMatches(commands, query, (command) => [command.name, ...command.aliases]);
		return {
			from: 0,
			to: cursor,
			items: matches.slice(0, MAX_COMPLETIONS).map((command) => ({
				label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
				insertText: `/${command.name} `,
				detail: command.summary
			}))
		};
	}

	const mentionMatch = before.match(/(^|\s)(@[^\s]*)$/);
	if (mentionMatch && !mentionMatch[2].startsWith("@[[")) {
		const query = mentionMatch[2].toLowerCase();
		const from = before.length - mentionMatch[2].length;
		return {
			from,
			to: cursor,
			items: rankMatches(MENTION_COMPLETIONS, query, (item) => [item.label]).slice(0, MAX_COMPLETIONS)
		};
	}

	return { from: cursor, to: cursor, items: [] };
}

export function formatConsoleHelp(commands: readonly ConsoleCommand[]): string {
	const width = Math.max(...commands.map((command) => command.name.length)) + 2;
	const line = (command: ConsoleCommand): string => `  /${command.name.padEnd(width)}${command.summary}`;
	const builtIns = commands.filter((command) => command.kind !== "workflow");
	const workflows = commands.filter((command) => command.kind === "workflow");
	return [
		"Commands",
		...builtIns.map(line),
		"",
		"Workflows (add text after the command for extra instructions)",
		...workflows.map(line),
		"",
		"Mentions",
		"  @selection      only the selected text",
		"  @note           the whole note, even with a selection",
		"  @folder         notes in the folder set in settings",
		"  @folder:Path    notes in that folder",
		"  @[[Note]]       add another note as context",
		"",
		"Keys",
		"  Tab or Enter accepts a suggestion, ↑ recalls earlier input, Esc closes suggestions or stops a request.",
		"  Start with // to send a question that begins with a slash."
	].join("\n");
}

export function formatTokenShort(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	}
	if (value >= 1000) {
		return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
	}
	return String(value);
}

export function formatConsoleStatus(input: {
	mode: OutputMode;
	providerName: string;
	model: string;
	effort: ReasoningEffort | null;
	dayUsedTokens: number;
	dayBudgetTokens: number;
}): ConsoleStatusSegment[] {
	const segments: ConsoleStatusSegment[] = [
		{ kind: "mode", text: input.mode.toUpperCase(), title: `Output mode: ${input.mode}. Click to change.` },
		{ kind: "model", text: input.model, title: `${input.providerName}: ${input.model}` }
	];
	if (input.effort) {
		segments.push({ kind: "effort", text: input.effort, title: `Reasoning effort: ${input.effort}` });
	}
	const usage = input.dayBudgetTokens > 0
		? { text: `day ${Math.min(999, Math.round((input.dayUsedTokens / input.dayBudgetTokens) * 100))}%`, title: `${input.dayUsedTokens.toLocaleString()} of ${input.dayBudgetTokens.toLocaleString()} daily tokens used` }
		: { text: `today ${formatTokenShort(input.dayUsedTokens)}`, title: `${input.dayUsedTokens.toLocaleString()} tokens used today` };
	segments.push({ kind: "usage", ...usage });
	return segments;
}
