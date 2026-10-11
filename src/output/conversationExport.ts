import type { ChatMessage } from "../shared/types";

export interface ConversationExportMeta {
	title: string;
	/** ISO 8601 UTC. Written to frontmatter. */
	exportedAt: string;
	/** Readable local time for the prose line, computed by the caller so this module stays timezone independent. */
	exportedAtLabel?: string;
	providerName?: string;
	model?: string;
}

const DEFAULT_EXPORT_TITLE = "AskMate conversation";

/** User and assistant turns with text. System lines (status, errors, console output) are deliberately left out. */
export function getExportableTurns(messages: readonly ChatMessage[]): ChatMessage[] {
	return messages.filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0);
}

export function hasExportableTurns(messages: readonly ChatMessage[]): boolean {
	return getExportableTurns(messages).length > 0;
}

function toSingleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** A JSON string is a valid YAML double-quoted scalar, so quotes, colons and unicode in titles stay safe. */
function yamlString(value: string): string {
	return JSON.stringify(toSingleLine(value));
}

function wikilink(path: string): string | null {
	const target = path.replace(/\.md$/i, "");
	return target.trim() && !/[\][|\n]/.test(target) ? `[[${target}]]` : null;
}

function describeMessageModel(message: ChatMessage, fallbackModel?: string): string {
	const model = message.model ?? fallbackModel;
	return model ? ` (${toSingleLine(model)})` : "";
}

/**
 * Appends a closing fence when the text ends inside a code fence, so one truncated reply cannot turn every later
 * section of the exported note into code. Follows CommonMark: a closing fence uses the opening character, is at
 * least as long, and has nothing but whitespace after it.
 */
export function closeOpenFence(text: string): string {
	const open = text.split(/\r?\n/).reduce<string | null>((fence, line) => {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!marker) {
			return fence;
		}
		if (fence === null) {
			// A backtick fence's info string cannot contain backticks, so "``` inline" text is not an opener.
			return marker[1][0] === "`" && marker[2].includes("`") ? null : marker[1];
		}
		return marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim() ? null : fence;
	}, null);
	return open === null ? text : `${text}\n${open}`;
}

function renderTurn(message: ChatMessage, fallbackModel?: string): string {
	const lines: string[] = [];
	if (message.role === "user") {
		lines.push("## You", "", closeOpenFence(message.text.trim()));
		const link = message.sourcePath ? wikilink(message.sourcePath) : null;
		if (link) {
			lines.push("", `Source note: ${link}`);
		}
		return lines.join("\n");
	}
	lines.push(`## AskMate${describeMessageModel(message, fallbackModel)}`, "", closeOpenFence(message.text.trim()));
	if (message.image) {
		const safePath = message.imagePath && !/[\][|\n]/.test(message.imagePath) ? message.imagePath : null;
		lines.push("", safePath ? `![[${safePath}]]` : "_Image generated in AskMate and not saved to the vault._");
	}
	if (message.incomplete) {
		lines.push("", "> [!warning] Incomplete reply", "> The provider stopped before this answer was finished.");
	}
	return lines.join("\n");
}

/**
 * Turns the sidebar transcript into a note body. Assistant Markdown is kept verbatim, source notes become links,
 * and incomplete replies and unsaved images are marked. Error and status lines are omitted.
 */
export function conversationToMarkdown(messages: readonly ChatMessage[], meta: ConversationExportMeta): string {
	const turns = getExportableTurns(messages);
	const title = toSingleLine(meta.title) || DEFAULT_EXPORT_TITLE;
	const frontmatter = [
		"---",
		`title: ${yamlString(title)}`,
		`exported: ${meta.exportedAt}`,
		...(meta.providerName ? [`provider: ${yamlString(meta.providerName)}`] : []),
		...(meta.model ? [`model: ${yamlString(meta.model)}`] : []),
		`turns: ${turns.length}`,
		"source: AskMate",
		"---"
	];
	const details = [
		meta.exportedAtLabel ? `Exported ${meta.exportedAtLabel}` : "",
		meta.providerName && meta.model ? `${meta.providerName}, ${meta.model}` : meta.model ?? meta.providerName ?? ""
	].filter(Boolean);
	const header = [...frontmatter, "", `# ${title.replace(/^#+\s*/, "")}`, ...(details.length > 0 ? ["", details.join(" · ")] : [])];
	const body = turns.map((turn) => renderTurn(turn, meta.model));
	return `${[header.join("\n"), ...body].join("\n\n---\n\n")}\n`;
}

/** Title for an export: the caller's text, otherwise the first question, otherwise a plain default. */
export function resolveExportTitle(requested: string, messages: readonly ChatMessage[]): string {
	const explicit = toSingleLine(requested);
	if (explicit) {
		return explicit;
	}
	const firstQuestion = getExportableTurns(messages).find((message) => message.role === "user");
	const firstLine = firstQuestion?.text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
	const characters = Array.from(toSingleLine(firstLine));
	return characters.length > 0 ? characters.slice(0, 60).join("").trimEnd() : DEFAULT_EXPORT_TITLE;
}
