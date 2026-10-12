import {
	DEFAULT_RECENT_COUNT,
	MAX_RECENT_COUNT,
	normaliseTag,
	parseRecentCount,
	vaultMentionKey,
	type VaultMention
} from "../../context/vaultMentions";
import type { ComposerLayout, ContextScope, OutputMode, ReasoningEffort, Workflow } from "../../shared/types";

/**
 * Pure command language of the sidebar: slash commands, @mentions, completion, help and the status line. Every composer layout
 * reads it; the Console shows the status line and the history as well.
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
	| "history"
	| "model"
	| "provider"
	| "export"
	| "new-thread"
	| "threads"
	| "rename-thread"
	| "delete-thread"
	| "setup"
	| "welcome"
	| "skills"
	| "skill"
	| "diagram"
	| "mcp"
	| "test"
	| "images";

export interface ConsoleCommand {
	/** Typed after the slash, lower case. */
	name: string;
	aliases: string[];
	summary: string;
	kind: ConsoleCommandKind;
	argumentHint?: string;
	workflowId?: string;
	outputMode?: OutputMode;
	/** Runs only when typed in full, never by a unique prefix, because a slip would lose something. */
	destructive?: boolean;
}

export interface ConsoleMentions {
	scope: ContextScope;
	/** null when @folder was not used; "" for the folder configured in settings; otherwise the folder typed after @folder:. */
	folder: string | null;
	/** Extra notes added with @[[Note]]. */
	notes: string[];
	/** Vault-aware mentions (@links, @backlinks, @tag:, @recent), resolved later against the current note. */
	vault: VaultMention[];
	/** Skills named with @skill:name, lower case. Whether each exists is for the skill service to decide. */
	skills: string[];
}

export type ConsoleAction =
	/**
	 * literal: the line started with "//", so the question is sent as typed and never treated as an image command.
	 * hints: soft notes about how a mention was read, for the view to show next to the composer.
	 */
	| { kind: "ask"; question: string; outputMode: OutputMode | null; mentions: ConsoleMentions; literal: boolean; hints: string[] }
	| { kind: "image"; prompt: string; mentions: ConsoleMentions }
	| { kind: "workflow"; workflowId: string; extra: string; mentions: ConsoleMentions }
	/** An empty prompt asks for a diagram of the current note. */
	| { kind: "diagram"; prompt: string; mentions: ConsoleMentions }
	/** An empty question selects the skill for the thread instead of running a request. */
	| { kind: "skill"; name: string; question: string; mentions: ConsoleMentions }
	| { kind: "mode"; mode: OutputMode }
	| { kind: "effort"; effort: ReasoningEffort | null }
	| { kind: "layout"; layout: ComposerLayout }
	| { kind: "clear" }
	| { kind: "help" }
	| { kind: "context"; mentions: ConsoleMentions }
	| { kind: "inspect"; question: string; mentions: ConsoleMentions }
	| { kind: "history" }
	| { kind: "model"; query: string }
	| { kind: "provider"; query: string }
	| { kind: "export"; title: string }
	| { kind: "newThread" }
	| { kind: "threads" }
	| { kind: "renameThread"; title: string }
	| { kind: "deleteThread" }
	| { kind: "setup" }
	| { kind: "welcome" }
	| { kind: "skills" }
	| { kind: "mcp" }
	| { kind: "test" }
	/** setting null shows the current state. */
	| { kind: "images"; setting: "on" | "off" | null }
	| { kind: "error"; message: string };

export interface ConsoleCompletion {
	label: string;
	insertText: string;
	detail: string;
	/** Heading the item is listed under, such as "Workflows" or "Commands". */
	group?: string;
}

export interface ConsoleCompletionResult {
	/** Index in the input where the replaced token starts. */
	from: number;
	/** Index in the input where the replaced token ends. */
	to: number;
	items: ConsoleCompletion[];
	/** How many more matches there are than `items` shows, for a "+N more, keep typing" row. */
	more: number;
}

/** Values offered after "/model ", "/provider ", "/skill " and "@skill:". */
export interface ConsoleArgumentSource {
	models: readonly string[];
	providers: readonly { id: string; label: string }[];
	vaultTags?: readonly string[];
	skills?: readonly { name: string; description?: string }[];
}

export interface ConsoleStatusSegment {
	kind: "mode" | "model" | "effort" | "usage";
	text: string;
	title: string;
}

function assertNever(value: never): never {
	throw new Error(`Unhandled console value: ${JSON.stringify(value)}`);
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
const EMPTY_MENU_WORKFLOWS = 6;
const EMPTY_MENU_COMMANDS = ["help", "diagram", "model", "new"];

const BUILT_IN_COMMANDS: ConsoleCommand[] = [
	{ name: "help", aliases: ["?", "commands"], summary: "List commands, workflows and mentions", kind: "help" },
	{ name: "setup", aliases: ["connect"], summary: "Connect an AI provider", kind: "setup" },
	{ name: "welcome", aliases: [], summary: "Show the welcome card again", kind: "welcome" },
	{ name: "diagram", aliases: [], summary: "Draw a Mermaid diagram of the note", kind: "diagram", argumentHint: "[what to draw]" },
	{ name: "skills", aliases: [], summary: "List the skills AskMate can use", kind: "skills" },
	{ name: "skill", aliases: [], summary: "Use a skill for a question, or for the whole conversation", kind: "skill", argumentHint: "<name> [question]" },
	{ name: "chat", aliases: [], summary: "Answer in this sidebar (with text: one question only)", kind: "mode", outputMode: "chat", argumentHint: "[question]" },
	{ name: "note", aliases: ["new-note"], summary: "Save answers as new notes (with text: one question only)", kind: "mode", outputMode: "note", argumentHint: "[question]" },
	{ name: "apply", aliases: [], summary: "Write answers into the note (with text: one question only)", kind: "mode", outputMode: "apply", argumentHint: "[question]" },
	{ name: "image", aliases: ["img"], summary: "Generate an image with OpenAI Images", kind: "image", argumentHint: "<prompt>" },
	{ name: "images", aliases: [], summary: "Turn image previews of linked pictures on or off", kind: "images", argumentHint: "[on|off]" },
	{ name: "effort", aliases: ["reasoning"], summary: "Set reasoning effort: none, low, medium, high, xhigh", kind: "effort", argumentHint: "<level>" },
	{ name: "context", aliases: ["ctx"], summary: "Show what the next request would send", kind: "context" },
	{ name: "inspect", aliases: ["prompt"], summary: "Open the final prompt for a question", kind: "inspect", argumentHint: "[question]" },
	{ name: "history", aliases: [], summary: "Show AskMate history for this note", kind: "history" },
	{ name: "clear", aliases: ["cls"], summary: "Clear the conversation", kind: "clear", destructive: true },
	{ name: "layout", aliases: [], summary: "Switch layout: console, compact, expanded", kind: "layout", argumentHint: "<layout>" },
	{ name: "model", aliases: ["models"], summary: "Show or switch the model (add ! for an unlisted ID)", kind: "model", argumentHint: "[id]" },
	{ name: "provider", aliases: ["providers"], summary: "Show or switch the chat provider", kind: "provider", argumentHint: "[id]" },
	{ name: "test", aliases: [], summary: "Test the connection to the provider", kind: "test" },
	{ name: "mcp", aliases: [], summary: "Show tool servers and their status", kind: "mcp" },
	{ name: "export", aliases: [], summary: "Export this conversation to a note", kind: "export", argumentHint: "[title]" },
	{ name: "new", aliases: ["new-thread"], summary: "Start a new conversation (the current one stays saved)", kind: "new-thread" },
	{ name: "threads", aliases: [], summary: "Switch to a saved conversation", kind: "threads" },
	{ name: "rename", aliases: [], summary: "Rename the current conversation", kind: "rename-thread", argumentHint: "<title>" },
	{ name: "delete-thread", aliases: [], summary: "Delete a saved conversation", kind: "delete-thread", destructive: true }
];

/**
 * The one form a command name is compared in: lower case, accents on Latin letters dropped, zero-width joiners removed and
 * the result recomposed (NFC). Keyboards and IMEs type NFC, while NFKD splits Persian hamza and madda alef, Hangul and
 * kana with a voiced mark, so folding without recomposing would make those names impossible to type.
 */
function foldCommandText(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f\u200c\u200d]/g, "")
		.normalize("NFC");
}

/**
 * Letters, digits and combining marks of any script, joined by hyphens, in the folded form. Accents on Latin letters are
 * dropped, while marks that carry meaning in other scripts, such as Devanagari vowel signs, are kept.
 */
export function slugifyCommandName(value: string): string {
	return foldCommandText(value)
		.replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
}

function nextCustomName(taken: ReadonlySet<string>): string {
	let index = 1;
	while (taken.has(`custom-${index}`)) {
		index += 1;
	}
	return `custom-${index}`;
}

/** Short name first; a clash falls back to the ID; a name with no letters or digits falls back to the full name, then custom-N. */
function pickCommandName(workflow: Workflow, taken: ReadonlySet<string>): string {
	const preferred = slugifyCommandName(workflow.shortName);
	if (preferred && !taken.has(preferred)) {
		return preferred;
	}
	const alternative = preferred ? slugifyCommandName(workflow.id) : slugifyCommandName(workflow.name);
	return alternative && !taken.has(alternative) ? alternative : nextCustomName(taken);
}

/** Built-in commands followed by one command per workflow, named after its short name and falling back to its id. */
export function buildConsoleCommands(workflows: readonly Workflow[]): ConsoleCommand[] {
	const taken = new Set(BUILT_IN_COMMANDS.flatMap((command) => [command.name, ...command.aliases]));
	const workflowCommands: ConsoleCommand[] = [];
	for (const workflow of workflows) {
		const name = pickCommandName(workflow, taken);
		taken.add(name);
		const aliases = [slugifyCommandName(workflow.id), slugifyCommandName(workflow.name)].filter((alias) => alias && !taken.has(alias));
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

function findCommand(typed: string, commands: readonly ConsoleCommand[]): { command: ConsoleCommand | null; candidates: ConsoleCommand[] } {
	const name = foldCommandText(typed);
	const exact = commands.find((command) => command.name === name || command.aliases.includes(name));
	if (exact) {
		return { command: exact, candidates: [exact] };
	}
	// A unique prefix runs the command, so "/pol" works like "/polish". Matches on the name come before matches on an alias.
	const byName = commands.filter((command) => command.name.startsWith(name));
	const byAlias = commands.filter((command) => !command.name.startsWith(name) && command.aliases.some((alias) => alias.startsWith(name)));
	const candidates = [...byName, ...byAlias];
	const only = candidates.length === 1 ? candidates[0] : null;
	return { command: only && !only.destructive ? only : null, candidates };
}

function describeCandidate(command: ConsoleCommand, typed: string): string {
	if (command.name.startsWith(typed)) {
		return `/${command.name}`;
	}
	const alias = command.aliases.find((candidate) => candidate.startsWith(typed));
	return alias ? `/${command.name} (${alias})` : `/${command.name}`;
}

// A mention may be followed by closing punctuation ("Summarise @note."); a bare folder name never ends with it.
// A full stop only ends a mention before whitespace or the end, so "@note.md" stays plain text. A bare argument stops at
// "," and ";" (quote the argument to use them), and a colon with no argument is consumed with the keyword.
// Groups: 1 lead, 2 backslash escape, 3 note link, 4 keyword, 5 colon, 6 quoted argument, 7 bare argument.
const MENTION_PATTERN = /(^|\s)(\\)?@(?:\[\[([^\]\n]+)\]\]|(selection|sel|note|folder|links|backlinks|recent|tag|skill)(?:(:)(?:"([^"\n]+)"|([^\s,;]*[^\s.,;:!?)]))?)?)(?=[\s,;:!?)]|\.(?=\s|$)|$)/gi;
// U+FFFF is a Unicode noncharacter, reserved for internal use, so it never stands for anything the user typed.
const REMOVED_MENTION = "\uffff";
// Several mentions in a row collapse to one marker, so removing them leaves a single space.
const ADJACENT_REMOVED_MENTIONS = new RegExp(`${REMOVED_MENTION}(?:[ \\t]+${REMOVED_MENTION})+`, "g");
// A private-use character stands in for code, so a mention inside it can never match and never reads as whitespace.
const CODE_MASK = "\ue000";

function maskInlineCode(line: string): string {
	let result = "";
	let index = 0;
	while (index < line.length) {
		if (line[index] !== "`") {
			result += line[index];
			index += 1;
			continue;
		}
		let runEnd = index;
		while (line[runEnd] === "`") {
			runEnd += 1;
		}
		const run = runEnd - index;
		let close = -1;
		let scan = runEnd;
		while (scan < line.length && close < 0) {
			if (line[scan] === "`") {
				let scanEnd = scan;
				while (line[scanEnd] === "`") {
					scanEnd += 1;
				}
				close = scanEnd - scan === run ? scanEnd : -1;
				scan = scanEnd;
			} else {
				scan += 1;
			}
		}
		if (close < 0) {
			// An unmatched run of backticks is ordinary text.
			result += line.slice(index, runEnd);
			index = runEnd;
		} else {
			result += CODE_MASK.repeat(close - index);
			index = close;
		}
	}
	return result;
}

/** A copy of the input, the same length, with fenced blocks and inline code spans replaced by a mask character. */
function maskCode(input: string): string {
	let fence: { char: string; length: number } | null = null;
	return input.split("\n").map((line) => {
		const content = line.endsWith("\r") ? line.slice(0, -1) : line;
		const tail = line.slice(content.length);
		if (fence) {
			const closing = new RegExp(`^ {0,3}\\${fence.char}{${fence.length},}[ \\t]*$`).test(content);
			if (closing) {
				fence = null;
			}
			return CODE_MASK.repeat(content.length) + tail;
		}
		const opening = /^ {0,3}(`{3,}|~{3,})/.exec(content);
		// A backtick fence cannot have a backtick in its info string; that line is inline code instead.
		if (opening && !(opening[1][0] === "`" && content.slice(opening[0].length).includes("`"))) {
			fence = { char: opening[1][0], length: opening[1].length };
			return CODE_MASK.repeat(content.length) + tail;
		}
		return maskInlineCode(content) + tail;
	}).join("\n");
}

export function normaliseSkillName(raw: string): string | null {
	const name = raw.trim().replace(/^\/+/, "").toLowerCase();
	return name || null;
}

export interface ExtractedMentions {
	text: string;
	mentions: ConsoleMentions;
	error: string | null;
	/** Soft notes about how a mention was read; never block sending. */
	hints: string[];
}

/**
 * Removes @mentions from the input. Unknown @words (such as email addresses) are left alone, and so is anything inside
 * code, after a backslash, or (for a bare @tag or @skill) in the middle of a sentence. With `lenient`, a mention that
 * could not be read stays as text instead of being an error, which is how a "//" line behaves.
 */
export function extractConsoleMentions(input: string, options: { lenient?: boolean } = {}): ExtractedMentions {
	const lenient = options.lenient ?? false;
	const mentions: ConsoleMentions = { scope: "auto", folder: null, notes: [], vault: [], skills: [] };
	const vaultErrors: string[] = [];
	const hints: string[] = [];
	const addVaultMention = (mention: VaultMention): void => {
		if (!mentions.vault.some((existing) => vaultMentionKey(existing) === vaultMentionKey(mention))) {
			mentions.vault.push(mention);
		}
	};
	const addHint = (hint: string): void => {
		if (!lenient && !hints.includes(hint)) {
			hints.push(hint);
		}
	};
	const scopes = new Set<ContextScope>();
	let error: string | null = null;

	let marked = "";
	let cursor = 0;
	let previousEnd = 0;
	for (const match of maskCode(input).matchAll(MENTION_PATTERN)) {
		const [whole, lead = "", escape, note, keyword, colon, quoted, bare] = match;
		const start = match.index;
		const end = start + whole.length;
		const original = input.slice(start, end);
		marked += input.slice(cursor, start);
		cursor = end;

		if (whole.includes(CODE_MASK)) {
			marked += original;
			continue;
		}
		if (escape) {
			// "\@tag" sends the word; the backslash is only there to say so.
			marked += lead + original.slice(lead.length + 1);
			continue;
		}

		const mentionStart = start + lead.length;
		const wordAfter = /^\s+[\p{L}\p{N}]/u.test(input.slice(end));
		const proseBefore = input.slice(previousEnd, mentionStart).trim().length > 0;
		const consume = (): string => {
			previousEnd = end;
			return `${lead}${REMOVED_MENTION}`;
		};
		const literal = (): string => original;

		if (note) {
			// Only the note itself is attached; an alias, heading or block reference does not change which note that is.
			const target = note.split("|")[0].split(/[#^]/)[0].trim();
			if (target && !mentions.notes.includes(target)) {
				mentions.notes.push(target);
			}
			marked += consume();
			continue;
		}

		const name = (keyword ?? "").toLowerCase();
		const argument = (quoted ?? bare ?? "").trim();
		const hintForKeyword = (): void => {
			if (proseBefore && wordAfter) {
				addHint(`"@${name}" was read as a mention and removed from your question. Write \\@${name} to send the word itself.`);
			}
		};

		if (name === "folder") {
			mentions.folder = argument;
			hintForKeyword();
			marked += consume();
			continue;
		}
		if (name === "links" || name === "backlinks") {
			if (argument) {
				marked += literal();
				continue;
			}
			addVaultMention({ kind: name });
			hintForKeyword();
			marked += consume();
			continue;
		}
		if (name === "tag" || name === "skill") {
			const isTag = name === "tag";
			const missing = isTag
				? "@tag needs a tag, for example @tag:project or @tag:#project/alpha."
				: "@skill needs a skill name, for example @skill:mermaid-diagrams.";
			if (!colon && !argument && wordAfter) {
				// "the @tag annotation" is prose: send it as typed and say how to write a real mention.
				addHint(isTag
					? "\"@tag\" was sent as text. To attach notes with a tag, write @tag:name, for example @tag:project."
					: "\"@skill\" was sent as text. To use a skill, write @skill:name, for example @skill:mermaid-diagrams.");
				marked += literal();
				continue;
			}
			const value = isTag ? normaliseTag(argument) : normaliseSkillName(argument);
			if (!value) {
				if (lenient) {
					marked += literal();
				} else {
					vaultErrors.push(missing);
					marked += consume();
				}
				continue;
			}
			if (isTag) {
				addVaultMention({ kind: "tag", tag: value });
			} else if (!mentions.skills.includes(value)) {
				mentions.skills.push(value);
			}
			marked += consume();
			continue;
		}
		if (name === "recent") {
			const count = parseRecentCount(argument);
			if (count === null) {
				if (lenient) {
					marked += literal();
				} else {
					vaultErrors.push(`@recent:${argument} is not a number from 1 to ${MAX_RECENT_COUNT}. Use @recent or @recent:${DEFAULT_RECENT_COUNT}.`);
					marked += consume();
				}
				continue;
			}
			addVaultMention({ kind: "recent", count });
			hintForKeyword();
			marked += consume();
			continue;
		}
		if (argument) {
			// "@note:Something" is not a mention form; keep it as typed.
			marked += literal();
			continue;
		}
		scopes.add(name === "note" ? "note" : "selection");
		hintForKeyword();
		marked += consume();
	}
	marked += input.slice(cursor);

	// Tidy only where a mention was removed, so indentation, tables and pasted code keep their spacing.
	const text = marked
		.replace(ADJACENT_REMOVED_MENTIONS, REMOVED_MENTION)
		.replace(/[ \t]*\uffff[ \t]*(?=[.,;:!?)\r\n]|$)/g, "")
		.replace(/[ \t]*\uffff[ \t]*/g, " ")
		.trim();

	if (vaultErrors.length > 0) {
		error = vaultErrors[0];
	} else if (scopes.size > 1) {
		error = "Use either @selection or @note, not both.";
	} else if (scopes.size === 1) {
		mentions.scope = scopes.has("note") ? "note" : "selection";
	}
	return { text, mentions, error, hints };
}

function takesNoText(command: ConsoleCommand): ConsoleAction {
	return { kind: "error", message: `/${command.name} takes no text. Type /help to list commands.` };
}

export function parseConsoleInput(raw: string, commands: readonly ConsoleCommand[]): ConsoleAction {
	const trimmed = raw.trim();
	// "//text" sends a question that starts with a slash. It is decided before mentions are read, so a literal line
	// never fails because of an @word in it.
	const literalPrefix = trimmed.startsWith("//");
	const extracted = extractConsoleMentions(trimmed, { lenient: literalPrefix });
	if (extracted.error) {
		return { kind: "error", message: extracted.error };
	}
	const { mentions } = extracted;
	let text = extracted.text;

	if (!text) {
		return { kind: "error", message: trimmed ? "Add a question after the mentions." : "Type a question, or /help for commands." };
	}
	if (text.startsWith("//")) {
		return { kind: "ask", question: text.slice(1), outputMode: null, mentions, literal: true, hints: extracted.hints };
	}
	if (!text.startsWith("/")) {
		return { kind: "ask", question: text, outputMode: null, mentions, literal: false, hints: extracted.hints };
	}

	const match = text.match(/^\/(\S*)\s*([\s\S]*)$/);
	const name = foldCommandText(match?.[1] ?? "");
	const argument = (match?.[2] ?? "").trim();
	if (!name) {
		return { kind: "error", message: "Type a command after the slash, or /help to list them." };
	}
	const { command, candidates } = findCommand(name, commands);
	if (!command) {
		if (candidates.length === 1) {
			return { kind: "error", message: `/${name} matches /${candidates[0].name}, which cannot be undone. Type the whole command name to run it.` };
		}
		return candidates.length > 1
			? { kind: "error", message: `/${name} could mean ${candidates.slice(0, 6).map((candidate) => describeCandidate(candidate, name)).join(", ")}${candidates.length > 6 ? " and more" : ""}. Type more of the name.` }
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
			return text ? { kind: "ask", question: text, outputMode: mode, mentions, literal: false, hints: extracted.hints } : { kind: "mode", mode };
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
			return text ? takesNoText(command) : { kind: "clear" };
		case "help":
			return text ? takesNoText(command) : { kind: "help" };
		case "context":
			return text ? takesNoText(command) : { kind: "context", mentions };
		case "inspect":
			return { kind: "inspect", question: text, mentions };
		case "history":
			return text ? takesNoText(command) : { kind: "history" };
		case "model":
			return { kind: "model", query: text };
		case "provider":
			return { kind: "provider", query: text };
		case "export":
			return { kind: "export", title: text };
		case "new-thread":
			// "/new <question>" used to reach /new-note by prefix, so say where that went rather than drop the text.
			return text
				? { kind: "error", message: "/new starts an empty conversation and takes no text. To save one answer as a note, use /note <question>." }
				: { kind: "newThread" };
		case "threads":
			return text ? takesNoText(command) : { kind: "threads" };
		case "rename-thread":
			return text ? { kind: "renameThread", title: text } : { kind: "error", message: "Add a title after /rename, for example /rename Budget review." };
		case "delete-thread":
			return text ? takesNoText(command) : { kind: "deleteThread" };
		case "setup":
			return text ? takesNoText(command) : { kind: "setup" };
		case "welcome":
			return text ? takesNoText(command) : { kind: "welcome" };
		case "skills":
			return text ? takesNoText(command) : { kind: "skills" };
		case "skill": {
			const parts = /^(?:"([^"]+)"|(\S+))\s*([\s\S]*)$/.exec(text);
			const skillName = parts ? normaliseSkillName(parts[1] ?? parts[2] ?? "") : null;
			// With no name there is nothing to run, so show the list the user can pick from.
			return parts && skillName ? { kind: "skill", name: skillName, question: parts[3].trim(), mentions } : { kind: "skills" };
		}
		case "diagram":
			return { kind: "diagram", prompt: text, mentions };
		case "mcp":
			return text ? takesNoText(command) : { kind: "mcp" };
		case "test":
			return text ? takesNoText(command) : { kind: "test" };
		case "images": {
			const setting = text.toLowerCase();
			if (!setting) {
				return { kind: "images", setting: null };
			}
			return setting === "on" || setting === "off" ? { kind: "images", setting } : { kind: "error", message: "Use /images on or /images off." };
		}
		default:
			return assertNever(command.kind);
	}
}

export type ConsoleActionCategory = "request" | "local" | "error";

/**
 * Sorts every action into one of three groups. The switch has no default branch that accepts anything, so adding an
 * action kind without deciding which group it belongs to is a compile error.
 */
export function classifyConsoleAction(action: ConsoleAction): ConsoleActionCategory {
	switch (action.kind) {
		case "ask":
		case "image":
		case "workflow":
		case "diagram":
			return "request";
		case "skill":
			return action.question ? "request" : "local";
		case "error":
			return "error";
		case "mode":
		case "effort":
		case "layout":
		case "clear":
		case "help":
		case "context":
		case "inspect":
		case "history":
		case "model":
		case "provider":
		case "export":
		case "newThread":
		case "threads":
		case "renameThread":
		case "deleteThread":
		case "setup":
		case "welcome":
		case "skills":
		case "mcp":
		case "test":
		case "images":
			return "local";
		default:
			return assertNever(action);
	}
}

/** True when running the action sends a request to the provider, so the view must check it is idle first. */
export function isRequestAction(action: ConsoleAction): boolean {
	return classifyConsoleAction(action) === "request";
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

/** Commands whose name, alias or summary contains the query, best matches first. */
function rankCommands(commands: readonly ConsoleCommand[], query: string): ConsoleCommand[] {
	const score = (command: ConsoleCommand): number => {
		const names = [command.name, ...command.aliases];
		if (command.name.startsWith(query)) {
			return 0;
		}
		if (names.some((value) => value.startsWith(query))) {
			return 1;
		}
		if (names.some((value) => value.includes(query))) {
			return 2;
		}
		return foldCommandText(command.summary).includes(query) ? 3 : 4;
	};
	return commands
		.map((command, index) => ({ command, index, rank: score(command) }))
		.filter((entry) => entry.rank < 4)
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.map((entry) => entry.command);
}

const MENTION_COMPLETIONS: ConsoleCompletion[] = [
	{ label: "@selection", insertText: "@selection ", detail: "Only the selected text; stops if nothing is selected", group: "Mentions" },
	{ label: "@note", insertText: "@note ", detail: "The whole note, even when text is selected", group: "Mentions" },
	{ label: "@folder", insertText: "@folder ", detail: "Notes in the folder set in AskMate settings", group: "Mentions" },
	{ label: "@folder:", insertText: "@folder:", detail: "Notes in a folder you name, for example @folder:Projects", group: "Mentions" },
	{ label: "@links", insertText: "@links ", detail: "Notes the current note links to", group: "Mentions" },
	{ label: "@backlinks", insertText: "@backlinks ", detail: "Notes that link to the current note", group: "Mentions" },
	{ label: "@tag:", insertText: "@tag:", detail: "Notes with a tag, for example @tag:project", group: "Mentions" },
	{ label: "@recent", insertText: "@recent ", detail: `The ${DEFAULT_RECENT_COUNT} most recently modified notes; up to @recent:${MAX_RECENT_COUNT}`, group: "Mentions" },
	{ label: "@skill:", insertText: "@skill:", detail: "Use a skill for this question, for example @skill:mermaid-diagrams", group: "Mentions" },
	{ label: "@[[", insertText: "@[[", detail: "Add another note, for example @[[Vendors]]", group: "Mentions" }
];

function tagCompletions(vaultTags: readonly string[], query: string): ConsoleCompletion[] {
	const bare = (tag: string): string => tag.replace(/^#/, "");
	const items = vaultTags.map(bare).filter((tag) => tag.toLowerCase().includes(query));
	return rankMatches(items, query, (tag) => [tag.toLowerCase()])
		.slice(0, MAX_COMPLETIONS)
		.map((tag) => ({ label: `@tag:${tag}`, insertText: `@tag:${tag} `, detail: "Notes with this tag" }));
}

function quoteIfNeeded(name: string): string {
	return /\s/.test(name) ? `"${name}"` : name;
}

function skillCompletions(skills: readonly { name: string; description?: string }[], query: string, asMention: boolean): { items: ConsoleCompletion[]; total: number } {
	const matches = rankMatches(skills, query, (skill) => [skill.name.toLowerCase()]);
	const ranked = query ? matches : [...skills];
	return {
		total: ranked.length,
		items: ranked.slice(0, MAX_COMPLETIONS).map((skill) => ({
			label: asMention ? `@skill:${skill.name}` : skill.name,
			insertText: asMention ? `@skill:${quoteIfNeeded(skill.name)} ` : `${quoteIfNeeded(skill.name)} `,
			detail: skill.description ?? "Skill",
			group: "Skills"
		}))
	};
}

function commandItem(command: ConsoleCommand): ConsoleCompletion {
	return {
		label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
		insertText: `/${command.name} `,
		detail: command.summary,
		group: command.kind === "workflow" ? "Workflows" : "Commands"
	};
}

/** Suggestions for the token before the cursor: a command at the start, or an @mention anywhere. */
export function getConsoleCompletions(
	input: string,
	cursor: number,
	commands: readonly ConsoleCommand[],
	argumentSource: ConsoleArgumentSource = { models: [], providers: [] }
): ConsoleCompletionResult {
	const before = input.slice(0, cursor);
	// Accepting a suggestion replaces the whole token, so text after the caret is not left behind as a stray suffix.
	const tokenEnd = cursor + (/^\S*/.exec(input.slice(cursor))?.[0].length ?? 0);
	const argumentMatch = before.match(/^\/([^\s]+)\s+([^\s]*)$/);
	if (argumentMatch) {
		const kind = findCommand(argumentMatch[1], commands).command?.kind;
		if (kind === "model" || kind === "provider") {
			const query = argumentMatch[2].toLowerCase();
			// An empty argument offers nothing, so Enter after "/model " still lists models instead of picking one.
			if (!query) {
				return { from: cursor, to: cursor, items: [], more: 0 };
			}
			const candidates: ConsoleCompletion[] = kind === "model"
				? argumentSource.models.map((model) => ({ label: model, insertText: model, detail: "Model" }))
				: argumentSource.providers.map((provider) => ({ label: provider.id, insertText: provider.id, detail: provider.label }));
			const ranked = rankMatches(candidates, query, (item) => [item.label.toLowerCase(), item.detail.toLowerCase()]);
			return {
				from: cursor - argumentMatch[2].length,
				to: tokenEnd,
				items: ranked.slice(0, MAX_COMPLETIONS),
				more: Math.max(0, ranked.length - MAX_COMPLETIONS)
			};
		}
		if (kind === "skill" && argumentSource.skills?.length) {
			const query = argumentMatch[2].toLowerCase();
			const found = skillCompletions(argumentSource.skills, query, false);
			return { from: cursor - argumentMatch[2].length, to: tokenEnd, items: found.items, more: Math.max(0, found.total - found.items.length) };
		}
	}
	const commandMatch = before.match(/^\/([^\s]*)$/);
	if (commandMatch) {
		const query = foldCommandText(commandMatch[1]);
		if (!query) {
			// A bare slash lists workflows first, because they are what people come to the menu for, then a few commands.
			const workflows = commands.filter((command) => command.kind === "workflow").slice(0, EMPTY_MENU_WORKFLOWS);
			const others = EMPTY_MENU_COMMANDS.flatMap((name) => commands.filter((command) => command.name === name && command.kind !== "workflow"));
			const items = [...workflows, ...others].map(commandItem);
			return { from: 0, to: tokenEnd, items, more: Math.max(0, commands.length - items.length) };
		}
		const matches = rankCommands(commands, query);
		return {
			from: 0,
			to: tokenEnd,
			items: matches.slice(0, MAX_COMPLETIONS).map(commandItem),
			more: Math.max(0, matches.length - MAX_COMPLETIONS)
		};
	}

	const mentionMatch = before.match(/(^|\s)(@[^\s]*)$/);
	if (mentionMatch && !mentionMatch[2].startsWith("@[[")) {
		const query = mentionMatch[2].toLowerCase();
		const from = before.length - mentionMatch[2].length;
		const tagQuery = /^@tag:#?(.*)$/i.exec(mentionMatch[2]);
		if (tagQuery) {
			const items = tagCompletions(argumentSource.vaultTags ?? [], tagQuery[1].toLowerCase());
			return { from, to: tokenEnd, items, more: 0 };
		}
		const skillQuery = /^@skill:"?(.*?)"?$/i.exec(mentionMatch[2]);
		if (skillQuery) {
			const found = skillCompletions(argumentSource.skills ?? [], skillQuery[1].toLowerCase(), true);
			return { from, to: tokenEnd, items: found.items, more: Math.max(0, found.total - found.items.length) };
		}
		const ranked = rankMatches(MENTION_COMPLETIONS, query, (item) => [item.label]);
		return { from, to: tokenEnd, items: ranked.slice(0, MAX_COMPLETIONS), more: Math.max(0, ranked.length - MAX_COMPLETIONS) };
	}

	return { from: cursor, to: cursor, items: [], more: 0 };
}

export function formatConsoleHelp(commands: readonly ConsoleCommand[]): string {
	const builtIns = commands.filter((command) => command.kind !== "workflow");
	const workflows = commands.filter((command) => command.kind === "workflow");
	const usage = (command: ConsoleCommand): string => `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
	const builtInWidth = Math.max(...builtIns.map((command) => usage(command).length)) + 2;
	const workflowWidth = Math.max(...workflows.map((command) => usage(command).length), 0) + 2;
	const aliasNote = (command: ConsoleCommand): string => command.aliases.length > 0 ? ` (also ${command.aliases.map((alias) => `/${alias}`).join(", ")})` : "";
	return [
		"Start here",
		"  Type a question and press Enter.",
		"  /setup          connect an AI provider",
		"  /diagram        draw a diagram of the note",
		"  /               pick a workflow, such as a summary or a plan",
		"",
		"Commands",
		...builtIns.map((command) => `  ${usage(command).padEnd(builtInWidth)}${command.summary}${aliasNote(command)}`),
		"",
		"Workflows (add text after the command for extra instructions)",
		...workflows.map((command) => `  /${command.name.padEnd(workflowWidth - 1)}${command.summary}`),
		"",
		"Mentions",
		"  @selection      only the selected text",
		"  @note           the whole note, even with a selection",
		"  @folder         notes in the folder set in settings",
		"  @folder:Path    notes in that folder",
		"  @[[Note]]       add another note as context",
		"  @links          notes the current note links to",
		"  @backlinks      notes that link to the current note",
		"  @tag:name       notes with that tag, nested tags included",
		`  @recent         the ${DEFAULT_RECENT_COUNT} most recently modified notes (@recent:${MAX_RECENT_COUNT} for up to ${MAX_RECENT_COUNT})`,
		"  @skill:name     use a skill for this question",
		"  \\@word          a backslash sends the word as text; code spans and code blocks are never read",
		"",
		"Keys",
		"  Tab or Enter accepts a suggestion, and Esc closes the suggestions.",
		"  In the Console layout, ↑ recalls earlier input and Esc also stops a request.",
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
