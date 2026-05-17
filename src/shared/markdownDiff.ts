import type { MarkdownDiffLine } from "./types";

export function buildMarkdownLineDiff(before: string, after: string): MarkdownDiffLine[] {
	const oldLines = before.split(/\r?\n/);
	const newLines = after.split(/\r?\n/);
	const maxPreciseLines = 400;

	if (oldLines.length > maxPreciseLines || newLines.length > maxPreciseLines) {
		let prefix = 0;
		while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
			prefix += 1;
		}
		let suffix = 0;
		while (
			suffix + prefix < oldLines.length
			&& suffix + prefix < newLines.length
			&& oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
		) {
			suffix += 1;
		}
		const rows: MarkdownDiffLine[] = [];
		for (let index = Math.max(0, prefix - 8); index < prefix; index += 1) {
			rows.push({ kind: "context", oldLineNumber: index + 1, newLineNumber: index + 1, text: oldLines[index] ?? "" });
		}
		rows.push({ kind: "context", oldLineNumber: null, newLineNumber: null, text: "[Large diff truncated to changed region]" });
		oldLines.slice(prefix, oldLines.length - suffix).slice(0, 200).forEach((line, index) => {
			rows.push({ kind: "removed", oldLineNumber: prefix + index + 1, newLineNumber: null, text: line });
		});
		newLines.slice(prefix, newLines.length - suffix).slice(0, 200).forEach((line, index) => {
			rows.push({ kind: "added", oldLineNumber: null, newLineNumber: prefix + index + 1, text: line });
		});
		for (let index = Math.max(prefix, oldLines.length - suffix); index < oldLines.length; index += 1) {
			const newIndex = newLines.length - (oldLines.length - index);
			rows.push({ kind: "context", oldLineNumber: index + 1, newLineNumber: newIndex + 1, text: oldLines[index] ?? "" });
		}
		return rows;
	}

	const lengths = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));
	for (let i = oldLines.length - 1; i >= 0; i -= 1) {
		for (let j = newLines.length - 1; j >= 0; j -= 1) {
			lengths[i][j] = oldLines[i] === newLines[j]
				? lengths[i + 1][j + 1] + 1
				: Math.max(lengths[i + 1][j], lengths[i][j + 1]);
		}
	}

	const diff: MarkdownDiffLine[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldLines.length || newIndex < newLines.length) {
		if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
			diff.push({ kind: "context", oldLineNumber: oldIndex + 1, newLineNumber: newIndex + 1, text: oldLines[oldIndex] });
			oldIndex += 1;
			newIndex += 1;
		} else if (newIndex < newLines.length && (oldIndex >= oldLines.length || lengths[oldIndex][newIndex + 1] >= lengths[oldIndex + 1][newIndex])) {
			diff.push({ kind: "added", oldLineNumber: null, newLineNumber: newIndex + 1, text: newLines[newIndex] });
			newIndex += 1;
		} else if (oldIndex < oldLines.length) {
			diff.push({ kind: "removed", oldLineNumber: oldIndex + 1, newLineNumber: null, text: oldLines[oldIndex] });
			oldIndex += 1;
		}
	}
	return diff;
}

export type TextApplyPreviewScope = "selected-text" | "append" | "heading-section" | "full-note";

export interface DiffConfirmOptions {
	scope: TextApplyPreviewScope;
	targetLabel: string;
	before: string;
	after: string;
	warning?: string;
	resolve: (value: boolean) => void;
}
