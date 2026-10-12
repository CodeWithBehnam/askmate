import { closeOpenFence } from "../safety/markdownFences";
import { prepareModelOutputForWrite } from "../safety/writePath";
import type { ChatMessage } from "../shared/types";
import type { SavedDiagramSummary } from "../threads/threadModel";

export { closeOpenFence };

export interface ConversationExportMeta {
	title: string;
	/** ISO 8601 UTC. Written to frontmatter. */
	exportedAt: string;
	/** Readable local time for the prose line, computed by the caller so this module stays timezone independent. */
	exportedAtLabel?: string;
	providerName?: string;
	model?: string;
	/**
	 * Builds the link to a source note, so the export can follow the user's link settings (Obsidian's
	 * generateMarkdownLink). When it is absent, or returns null, a wikilink to the path is written.
	 */
	linkFor?: (path: string) => string | null;
}

const DEFAULT_EXPORT_TITLE = "AskMate conversation";

/** A transcript message as the sidebar keeps it: a drawn diagram reply carries the outcome of its diagram. */
export type ExportableMessage = ChatMessage & { diagram?: SavedDiagramSummary };

/** User and assistant turns with text. System lines (status, errors, console output) are deliberately left out. */
export function getExportableTurns<T extends ChatMessage>(messages: readonly T[]): T[] {
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
 * A reply whose diagram drew carries the strict header AskMate built (frontmatter and classDef lines). Only that outcome
 * lets the header through the write guard, which still checks it against its closed schema. A reply that did not draw, or
 * that is not a diagram, keeps the strict rules.
 */
function holdsDrawnDiagram(message: ExportableMessage): boolean {
	return message.role === "assistant" && message.diagram !== undefined && message.diagram.status !== "fallback";
}

function renderTurn(message: ExportableMessage, meta: ConversationExportMeta): string {
	const fallbackModel = meta.model;
	const lines: string[] = [];
	if (message.role === "user") {
		lines.push("## You", "", closeOpenFence(message.text.trim()));
		const link = message.sourcePath ? (meta.linkFor?.(message.sourcePath) ?? wikilink(message.sourcePath)) : null;
		if (link) {
			lines.push("", `Source note: ${link}`);
		}
		return lines.join("\n");
	}
	// Assistant text is model output, and the exported note is vault content other plugins will read and run.
	const safe = prepareModelOutputForWrite(message.text.trim(), { allowPluginMermaidHeader: holdsDrawnDiagram(message) });
	lines.push(`## AskMate${describeMessageModel(message, fallbackModel)}`, "", closeOpenFence(safe.text));
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
 * Turns the sidebar transcript into a note body. Assistant Markdown is defused for writing (remote images, plugin code
 * blocks, template tags and other active constructs are neutralised) but otherwise kept as written, source notes become links,
 * and incomplete replies and unsaved images are marked. Error and status lines are omitted.
 */
export function conversationToMarkdown(messages: readonly ExportableMessage[], meta: ConversationExportMeta): string {
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
	const body = turns.map((turn) => renderTurn(turn, meta));
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
