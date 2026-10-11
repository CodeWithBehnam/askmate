import type { FolderInstruction } from "../shared/types";

export const MAX_GLOBAL_INSTRUCTIONS_LENGTH = 4000;
export const MAX_FOLDER_INSTRUCTION_LENGTH = 2000;
export const MAX_FOLDER_INSTRUCTION_RULES = 20;
const MAX_FOLDER_PATH_LENGTH = 400;

export interface ResolvedInstructions {
	global: string;
	/** Matching folder rules, outermost folder first, so the most specific rule is read last. */
	folders: FolderInstruction[];
}

function cleanText(value: unknown, maxLength: number): string {
	return typeof value === "string" ? value.replace(/\0/g, "").slice(0, maxLength).trim() : "";
}

/** Folds "A//B/", "/A/B" and " A/B " into "A/B". Returns "" for the vault root or an unsafe path. */
export function normalizeInstructionFolder(value: unknown): string {
	if (typeof value !== "string") {
		return "";
	}
	const segments = value.replace(/\0/g, "").slice(0, MAX_FOLDER_PATH_LENGTH).split("/").map((segment) => segment.trim()).filter(Boolean);
	return segments.some((segment) => segment === "." || segment === "..") ? "" : segments.join("/");
}

/** Drops malformed rules and rules with no folder or no text, then caps the count and the length of each rule. */
export function normalizeFolderInstructions(value: unknown): FolderInstruction[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.flatMap((item: unknown): FolderInstruction[] => {
			if (typeof item !== "object" || item === null) {
				return [];
			}
			const record = item as Record<string, unknown>;
			const folder = normalizeInstructionFolder(record.folder);
			const instructions = cleanText(record.instructions, MAX_FOLDER_INSTRUCTION_LENGTH);
			return folder && instructions ? [{ folder, instructions }] : [];
		})
		.slice(0, MAX_FOLDER_INSTRUCTION_RULES);
}

export function normalizeGlobalInstructions(value: unknown): string {
	return cleanText(value, MAX_GLOBAL_INSTRUCTIONS_LENGTH);
}

/** Path-segment match, so "Projects" covers "Projects/a.md" and "Projects/x/b.md" but not "ProjectsOld/c.md". Case-sensitive like vault paths. */
export function isNoteInFolder(notePath: string, folder: string): boolean {
	const folderSegments = normalizeInstructionFolder(folder).split("/").filter(Boolean);
	if (folderSegments.length === 0) {
		return false;
	}
	const directories = notePath.split("/").filter(Boolean).slice(0, -1);
	return folderSegments.length <= directories.length && folderSegments.every((segment, index) => directories[index] === segment);
}

export function resolveCustomInstructions(
	settings: { globalInstructions: string; folderInstructions: readonly FolderInstruction[] },
	notePath: string | null | undefined
): ResolvedInstructions {
	const folders = notePath
		? settings.folderInstructions
			.map((rule, index) => ({ rule: { folder: normalizeInstructionFolder(rule.folder), instructions: rule.instructions.trim() }, index }))
			.filter(({ rule }) => rule.folder && rule.instructions && isNoteInFolder(notePath, rule.folder))
			.sort((a, b) => a.rule.folder.split("/").length - b.rule.folder.split("/").length || a.index - b.index)
			.map(({ rule }) => rule)
		: [];
	return { global: settings.globalInstructions.trim(), folders };
}

/** Plain text for the prompt: global preferences first, then each matching folder rule from the outermost to the most specific. */
export function formatCustomInstructions(resolved: ResolvedInstructions): string {
	return [
		resolved.global,
		...resolved.folders.map((rule) => `For notes in the folder "${rule.folder}":\n${rule.instructions}`)
	].filter(Boolean).join("\n\n");
}
