import type { MarkdownDiffLine } from "./types";

// Exact LCS is quadratic, so only the changed middle of a note is diffed precisely, and only when it is small enough.
const MAX_PRECISE_LINES = 400;
// Notes up to this many rows are shown in full; longer diffs keep a few unchanged lines around each change.
const MAX_UNCOLLAPSED_ROWS = 150;
const CONTEXT_LINES = 3;
// Bounds DOM size in the approval modal; anything beyond it is announced with an explicit marker row, never dropped silently.
const MAX_CHANGED_ROWS = 400;

export interface MarkdownDiffStats {
	added: number;
	removed: number;
}

function contextRow(oldLineNumber: number, newLineNumber: number, text: string): MarkdownDiffLine {
	return { kind: "context", oldLineNumber, newLineNumber, text };
}

function omittedRow(text: string): MarkdownDiffLine {
	return { kind: "omitted", oldLineNumber: null, newLineNumber: null, text };
}

function plural(count: number, noun: string): string {
	return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function diffPrecisely(oldLines: string[], newLines: string[], oldOffset: number, newOffset: number): MarkdownDiffLine[] {
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
			diff.push(contextRow(oldOffset + oldIndex + 1, newOffset + newIndex + 1, oldLines[oldIndex]));
			oldIndex += 1;
			newIndex += 1;
		} else if (newIndex < newLines.length && (oldIndex >= oldLines.length || lengths[oldIndex][newIndex + 1] >= lengths[oldIndex + 1][newIndex])) {
			diff.push({ kind: "added", oldLineNumber: null, newLineNumber: newOffset + newIndex + 1, text: newLines[newIndex] });
			newIndex += 1;
		} else if (oldIndex < oldLines.length) {
			diff.push({ kind: "removed", oldLineNumber: oldOffset + oldIndex + 1, newLineNumber: null, text: oldLines[oldIndex] });
			oldIndex += 1;
		}
	}
	return diff;
}

function diffAsBlocks(oldLines: string[], newLines: string[], oldOffset: number, newOffset: number, maxRowsPerSide?: number): MarkdownDiffLine[] {
	const removed = oldLines.map((text, index): MarkdownDiffLine => ({ kind: "removed", oldLineNumber: oldOffset + index + 1, newLineNumber: null, text }));
	const added = newLines.map((text, index): MarkdownDiffLine => ({ kind: "added", oldLineNumber: null, newLineNumber: newOffset + index + 1, text }));
	if (maxRowsPerSide === undefined) {
		return [...removed, ...added];
	}
	// Show the start of both sides, so a huge rewrite never displays only deletions.
	const capSide = (rows: MarkdownDiffLine[], noun: string): MarkdownDiffLine[] => rows.length <= maxRowsPerSide
		? rows
		: [...rows.slice(0, maxRowsPerSide), omittedRow(`${plural(rows.length - maxRowsPerSide, noun)} not shown. Apply writes every change.`)];
	return [...capSide(removed, "more removed line"), ...capSide(added, "more added line")];
}

function collapseUnchangedRuns(rows: MarkdownDiffLine[]): MarkdownDiffLine[] {
	if (rows.length <= MAX_UNCOLLAPSED_ROWS) {
		return rows;
	}
	const collapsed: MarkdownDiffLine[] = [];
	let index = 0;
	while (index < rows.length) {
		if (rows[index].kind !== "context") {
			collapsed.push(rows[index]);
			index += 1;
			continue;
		}
		let end = index;
		while (end < rows.length && rows[end].kind === "context") {
			end += 1;
		}
		const keepBefore = index === 0 ? 0 : CONTEXT_LINES;
		const keepAfter = end === rows.length ? 0 : CONTEXT_LINES;
		const runLength = end - index;
		if (runLength <= keepBefore + keepAfter + 1) {
			collapsed.push(...rows.slice(index, end));
		} else {
			collapsed.push(...rows.slice(index, index + keepBefore));
			collapsed.push(omittedRow(`${plural(runLength - keepBefore - keepAfter, "unchanged line")} hidden`));
			collapsed.push(...rows.slice(end - keepAfter, end));
		}
		index = end;
	}
	return collapsed;
}

function capChangedRows(rows: MarkdownDiffLine[]): MarkdownDiffLine[] {
	const changedTotal = rows.filter((row) => row.kind === "added" || row.kind === "removed").length;
	if (changedTotal <= MAX_CHANGED_ROWS) {
		return rows;
	}
	const kept: MarkdownDiffLine[] = [];
	let shown = 0;
	for (const row of rows) {
		if (row.kind === "added" || row.kind === "removed") {
			if (shown === MAX_CHANGED_ROWS) {
				break;
			}
			shown += 1;
		}
		kept.push(row);
	}
	const hidden = rows.slice(kept.length);
	const hiddenRemoved = hidden.filter((row) => row.kind === "removed").length;
	const hiddenAdded = hidden.filter((row) => row.kind === "added").length;
	kept.push(omittedRow(`${plural(hiddenRemoved + hiddenAdded, "more changed line")} not shown (${hiddenRemoved.toLocaleString()} removed, ${hiddenAdded.toLocaleString()} added). Apply writes every change.`));
	return kept;
}

export function getMarkdownDiffStats(before: string, after: string): MarkdownDiffStats {
	const rows = buildFullDiff(before.split(/\r?\n/), after.split(/\r?\n/));
	return {
		added: rows.filter((row) => row.kind === "added").length,
		removed: rows.filter((row) => row.kind === "removed").length
	};
}

function buildFullDiff(oldLines: string[], newLines: string[], maxRowsPerSide?: number): MarkdownDiffLine[] {
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
	const middleOld = oldLines.slice(prefix, oldLines.length - suffix);
	const middleNew = newLines.slice(prefix, newLines.length - suffix);
	const middle = middleOld.length <= MAX_PRECISE_LINES && middleNew.length <= MAX_PRECISE_LINES
		? diffPrecisely(middleOld, middleNew, prefix, prefix)
		: diffAsBlocks(middleOld, middleNew, prefix, prefix, maxRowsPerSide);
	const oldSuffixStart = oldLines.length - suffix;
	const newSuffixStart = newLines.length - suffix;
	return [
		...oldLines.slice(0, prefix).map((text, index) => contextRow(index + 1, index + 1, text)),
		...middle,
		...oldLines.slice(oldSuffixStart).map((text, index) => contextRow(oldSuffixStart + index + 1, newSuffixStart + index + 1, text))
	];
}

/**
 * Line diff for the Apply approval modal. Every hidden region is announced with an "omitted" row that says how many lines
 * it covers, so the preview never implies that the user has seen every change when they have not.
 */
export function buildMarkdownLineDiff(before: string, after: string): MarkdownDiffLine[] {
	const rows = buildFullDiff(before.split(/\r?\n/), after.split(/\r?\n/), MAX_CHANGED_ROWS / 2);
	if (!rows.some((row) => row.kind !== "context")) {
		return [omittedRow(before === after ? "No changes." : "Only line endings change (for example CRLF to LF); the text is otherwise identical.")];
	}
	return capChangedRows(collapseUnchangedRuns(rows));
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
