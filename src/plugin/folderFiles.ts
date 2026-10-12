import { TFile, TFolder, type TAbstractFile } from "obsidian";
import type { SkillFileInfo } from "../skills";

/**
 * Every file below one folder, at any depth, read from the folder's own children. Walking the folder keeps the work to the
 * files that are actually in it: the vault is never listed as a whole. A missing folder gives an empty list.
 */
export function listFolderFiles(folder: TFolder | null): SkillFileInfo[] {
	const files: SkillFileInfo[] = [];
	const pending: TAbstractFile[] = folder ? [...folder.children] : [];
	for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
		if (entry instanceof TFile) {
			files.push({ path: entry.path, size: entry.stat.size });
		} else if (entry instanceof TFolder) {
			pending.push(...entry.children);
		}
	}
	return files;
}
