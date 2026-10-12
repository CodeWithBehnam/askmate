import type { MarkdownDiffLine } from "./types";

// Notes up to this many rows are shown in full; longer diffs keep a few unchanged lines around each change.
const MAX_UNCOLLAPSED_ROWS = 150;
const CONTEXT_LINES = 3;
// Bounds DOM size in the approval modal; anything beyond it is announced with an explicit marker row, never dropped silently.
const MAX_CHANGED_ROWS = 400;
// Myers' algorithm finds the shortest edit script in O((N + D) * D) time, so it is exact for any note whose changed
// lines number in the hundreds, however long the note and however far apart the edits are. Past this many edits the
// diff falls back to patience anchors.
const MYERS_MAX_EDITS = 1000;
// A gap between two anchors is small enough to be worth another exact attempt, with a higher bound.
const GAP_RETRY_MAX_LINES = 4000;
const GAP_MYERS_MAX_EDITS = 2000;
const MAX_PATIENCE_DEPTH = 6;

export interface MarkdownDiffStats {
	added: number;
	removed: number;
	/** Set when part of the diff could not be matched line by line, so the counts may be larger than the real change. */
	approximate?: true;
}

export interface MarkdownDiffSummary extends MarkdownDiffStats {
	/** Number of separate places in the note that changed. */
	places: number;
}

type DiffOp =
	| { kind: "equal"; oldIndex: number; newIndex: number }
	| { kind: "removed"; oldIndex: number }
	| { kind: "added"; newIndex: number }
	/** A stretch that was not matched line by line: every old line removed and every new line added. */
	| { kind: "block"; oldStart: number; oldEnd: number; newStart: number; newEnd: number };

interface DiffContext {
	oldLines: readonly string[];
	newLines: readonly string[];
	ops: DiffOp[];
	approximate: boolean;
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

/** Shortest edit script for the two ranges, or null when it needs more than `maxEdits` edits. */
function myersOps(context: DiffContext, aStart: number, aEnd: number, bStart: number, bEnd: number, maxEdits: number): DiffOp[] | null {
	const { oldLines, newLines } = context;
	const n = aEnd - aStart;
	const m = bEnd - bStart;
	const max = Math.min(n + m, maxEdits);
	if (max <= 0) {
		return null;
	}
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];

	for (let d = 0; d <= max; d += 1) {
		// Only the diagonals this round can read are kept, so memory grows with the square of the edit count, not of the note.
		trace.push(v.slice(offset - d - 1, offset + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && oldLines[aStart + x] === newLines[bStart + y]) {
				x += 1;
				y += 1;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				return backtrack(trace, d, n, m, aStart, bStart);
			}
		}
	}
	return null;
}

/** Walks the saved rounds back from the end of both ranges. Round `step` saved diagonals -step - 1 to step + 1, at index diagonal + step + 1. */
function backtrack(trace: readonly Int32Array[], editCount: number, n: number, m: number, aStart: number, bStart: number): DiffOp[] {
	const ops: DiffOp[] = [];
	let x = n;
	let y = m;
	for (let step = editCount; step > 0; step -= 1) {
		const previous = trace[step];
		const k = x - y;
		const down = k === -step || (k !== step && previous[k + step] < previous[k + step + 2]);
		const previousK = down ? k + 1 : k - 1;
		const previousX = previous[previousK + step + 1];
		const previousY = previousX - previousK;
		while (x > previousX && y > previousY) {
			x -= 1;
			y -= 1;
			ops.push({ kind: "equal", oldIndex: aStart + x, newIndex: bStart + y });
		}
		ops.push(down ? { kind: "added", newIndex: bStart + previousY } : { kind: "removed", oldIndex: aStart + previousX });
		x = previousX;
		y = previousY;
	}
	while (x > 0 && y > 0) {
		x -= 1;
		y -= 1;
		ops.push({ kind: "equal", oldIndex: aStart + x, newIndex: bStart + y });
	}
	return ops.reverse();
}

/** Lines that occur exactly once on each side and match, in old-line order. */
function findUniqueAnchors(context: DiffContext, aStart: number, aEnd: number, bStart: number, bEnd: number): Array<[number, number]> {
	const counts = new Map<string, { oldCount: number; oldIndex: number; newCount: number; newIndex: number }>();
	for (let index = aStart; index < aEnd; index += 1) {
		const entry = counts.get(context.oldLines[index]);
		if (entry) {
			entry.oldCount += 1;
		} else {
			counts.set(context.oldLines[index], { oldCount: 1, oldIndex: index, newCount: 0, newIndex: -1 });
		}
	}
	for (let index = bStart; index < bEnd; index += 1) {
		const entry = counts.get(context.newLines[index]);
		if (entry) {
			entry.newCount += 1;
			entry.newIndex = index;
		}
	}
	const pairs: Array<[number, number]> = [];
	for (let index = aStart; index < aEnd; index += 1) {
		const entry = counts.get(context.oldLines[index]);
		if (entry && entry.oldCount === 1 && entry.newCount === 1 && entry.oldIndex === index) {
			pairs.push([index, entry.newIndex]);
		}
	}
	return longestIncreasingSubsequence(pairs);
}

/** The longest run of pairs whose second values increase, given pairs ordered by their first value. */
function longestIncreasingSubsequence(pairs: ReadonlyArray<[number, number]>): Array<[number, number]> {
	const tails: number[] = [];
	const previous = new Array<number>(pairs.length).fill(-1);
	for (let index = 0; index < pairs.length; index += 1) {
		const value = pairs[index][1];
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (pairs[tails[middle]][1] < value) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}
		if (low > 0) {
			previous[index] = tails[low - 1];
		}
		tails[low] = index;
	}
	const result: Array<[number, number]> = [];
	for (let index = tails.length > 0 ? tails[tails.length - 1] : -1; index !== -1; index = previous[index]) {
		result.push(pairs[index]);
	}
	return result.reverse();
}

function sharesALine(context: DiffContext, aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
	const oldSet = new Set(context.oldLines.slice(aStart, aEnd));
	for (let index = bStart; index < bEnd; index += 1) {
		if (oldSet.has(context.newLines[index])) {
			return true;
		}
	}
	return false;
}

function emitBlock(context: DiffContext, aStart: number, aEnd: number, bStart: number, bEnd: number): void {
	if (aStart === aEnd) {
		for (let index = bStart; index < bEnd; index += 1) {
			context.ops.push({ kind: "added", newIndex: index });
		}
		return;
	}
	if (bStart === bEnd) {
		for (let index = aStart; index < aEnd; index += 1) {
			context.ops.push({ kind: "removed", oldIndex: index });
		}
		return;
	}
	// A stretch with no line in common is exactly a block. One that shares lines may hide matches this pass did not find.
	context.approximate ||= sharesALine(context, aStart, aEnd, bStart, bEnd);
	context.ops.push({ kind: "block", oldStart: aStart, oldEnd: aEnd, newStart: bStart, newEnd: bEnd });
}

/** Diffs one range: trims what both sides share, then tries the exact algorithm, then patience anchors, then a block. */
function diffRange(context: DiffContext, aStart: number, aEnd: number, bStart: number, bEnd: number, depth: number): void {
	const { oldLines, newLines, ops } = context;
	while (aStart < aEnd && bStart < bEnd && oldLines[aStart] === newLines[bStart]) {
		ops.push({ kind: "equal", oldIndex: aStart, newIndex: bStart });
		aStart += 1;
		bStart += 1;
	}
	let suffix = 0;
	while (aEnd - suffix > aStart && bEnd - suffix > bStart && oldLines[aEnd - 1 - suffix] === newLines[bEnd - 1 - suffix]) {
		suffix += 1;
	}
	diffCore(context, aStart, aEnd - suffix, bStart, bEnd - suffix, depth);
	for (let index = suffix; index > 0; index -= 1) {
		ops.push({ kind: "equal", oldIndex: aEnd - index, newIndex: bEnd - index });
	}
}

function diffCore(context: DiffContext, aStart: number, aEnd: number, bStart: number, bEnd: number, depth: number): void {
	if (aStart === aEnd || bStart === bEnd) {
		emitBlock(context, aStart, aEnd, bStart, bEnd);
		return;
	}

	const size = aEnd - aStart + (bEnd - bStart);
	const maxEdits = depth === 0 ? MYERS_MAX_EDITS : size <= GAP_RETRY_MAX_LINES ? GAP_MYERS_MAX_EDITS : 0;
	const exact = maxEdits > 0 ? myersOps(context, aStart, aEnd, bStart, bEnd, maxEdits) : null;
	if (exact) {
		for (const op of exact) {
			context.ops.push(op);
		}
		return;
	}

	const anchors = depth < MAX_PATIENCE_DEPTH ? findUniqueAnchors(context, aStart, aEnd, bStart, bEnd) : [];
	if (anchors.length === 0) {
		emitBlock(context, aStart, aEnd, bStart, bEnd);
		return;
	}
	let previousA = aStart;
	let previousB = bStart;
	for (const [anchorA, anchorB] of anchors) {
		diffRange(context, previousA, anchorA, previousB, anchorB, depth + 1);
		context.ops.push({ kind: "equal", oldIndex: anchorA, newIndex: anchorB });
		previousA = anchorA + 1;
		previousB = anchorB + 1;
	}
	diffRange(context, previousA, aEnd, previousB, bEnd, depth + 1);
}

/** Within each run of changes the removals come first, so a replaced line reads as "- old" then "+ new". */
function orderChanges(ops: readonly DiffOp[]): DiffOp[] {
	const ordered: DiffOp[] = [];
	let removed: DiffOp[] = [];
	let added: DiffOp[] = [];
	const flush = (): void => {
		for (const op of removed) {
			ordered.push(op);
		}
		for (const op of added) {
			ordered.push(op);
		}
		removed = [];
		added = [];
	};
	for (const op of ops) {
		if (op.kind === "removed" || op.kind === "block") {
			removed.push(op);
		} else if (op.kind === "added") {
			added.push(op);
		} else {
			flush();
			ordered.push(op);
		}
	}
	flush();
	return ordered;
}

function computeDiff(before: string, after: string): DiffContext {
	const context: DiffContext = { oldLines: before.split(/\r?\n/), newLines: after.split(/\r?\n/), ops: [], approximate: false };
	diffRange(context, 0, context.oldLines.length, 0, context.newLines.length, 0);
	context.ops = orderChanges(context.ops);
	return context;
}

function countStats(context: DiffContext): MarkdownDiffStats {
	let added = 0;
	let removed = 0;
	for (const op of context.ops) {
		if (op.kind === "added") {
			added += 1;
		} else if (op.kind === "removed") {
			removed += 1;
		} else if (op.kind === "block") {
			removed += op.oldEnd - op.oldStart;
			added += op.newEnd - op.newStart;
		}
	}
	return context.approximate ? { added, removed, approximate: true } : { added, removed };
}

function countPlaces(ops: readonly DiffOp[]): number {
	let places = 0;
	let inChange = false;
	for (const op of ops) {
		if (op.kind === "equal") {
			inChange = false;
		} else if (!inChange) {
			inChange = true;
			places += 1;
		}
	}
	return places;
}

function blockRows(op: Extract<DiffOp, { kind: "block" }>, oldLines: readonly string[], newLines: readonly string[], maxRowsPerSide?: number): MarkdownDiffLine[] {
	const removed = oldLines.slice(op.oldStart, op.oldEnd).map((text, index): MarkdownDiffLine => ({ kind: "removed", oldLineNumber: op.oldStart + index + 1, newLineNumber: null, text }));
	const added = newLines.slice(op.newStart, op.newEnd).map((text, index): MarkdownDiffLine => ({ kind: "added", oldLineNumber: null, newLineNumber: op.newStart + index + 1, text }));
	if (maxRowsPerSide === undefined) {
		return [...removed, ...added];
	}
	// Show the start of both sides, so a huge rewrite never displays only deletions.
	const capSide = (rows: MarkdownDiffLine[], noun: string): MarkdownDiffLine[] => rows.length <= maxRowsPerSide
		? rows
		: [...rows.slice(0, maxRowsPerSide), omittedRow(`${plural(rows.length - maxRowsPerSide, noun)} not shown. Apply writes every change.`)];
	return [...capSide(removed, "more removed line"), ...capSide(added, "more added line")];
}

function opsToRows(context: DiffContext, maxRowsPerSide: number): MarkdownDiffLine[] {
	const { oldLines, newLines } = context;
	return context.ops.flatMap((op): MarkdownDiffLine[] => {
		switch (op.kind) {
			case "equal":
				return [contextRow(op.oldIndex + 1, op.newIndex + 1, oldLines[op.oldIndex])];
			case "removed":
				return [{ kind: "removed", oldLineNumber: op.oldIndex + 1, newLineNumber: null, text: oldLines[op.oldIndex] }];
			case "added":
				return [{ kind: "added", oldLineNumber: null, newLineNumber: op.newIndex + 1, text: newLines[op.newIndex] }];
			case "block":
				return blockRows(op, oldLines, newLines, maxRowsPerSide);
		}
	});
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

/**
 * Counts the lines an Apply adds and removes. The counts are exact unless `approximate` is set, which only happens when
 * a huge rewrite shares repeated lines that could not be matched one by one.
 */
export function getMarkdownDiffStats(before: string, after: string): MarkdownDiffStats {
	return countStats(computeDiff(before, after));
}

/** Like {@link getMarkdownDiffStats}, and also counts the separate places in the note that change. */
export function summariseMarkdownDiff(before: string, after: string): MarkdownDiffSummary {
	const context = computeDiff(before, after);
	return { ...countStats(context), places: countPlaces(context.ops) };
}

/** One plain sentence for the Apply preview, for example "2 places changed: 2 lines added, 2 lines removed". */
export function describeMarkdownDiffSummary(summary: MarkdownDiffSummary): string {
	const places = `${summary.places.toLocaleString()} ${summary.places === 1 ? "place" : "places"} changed`;
	if (summary.approximate) {
		return `About ${places}: up to ${plural(summary.added, "line")} added, up to ${plural(summary.removed, "line")} removed`;
	}
	return `${places}: ${plural(summary.added, "line")} added, ${plural(summary.removed, "line")} removed`;
}

/**
 * Line diff for the Apply approval modal. Every hidden region is announced with an "omitted" row that says how many lines
 * it covers, so the preview never implies that the user has seen every change when they have not.
 */
export function buildMarkdownLineDiff(before: string, after: string): MarkdownDiffLine[] {
	const context = computeDiff(before, after);
	if (!context.ops.some((op) => op.kind !== "equal")) {
		return [omittedRow(before === after ? "No changes." : "Only line endings change (for example CRLF to LF); the text is otherwise identical.")];
	}
	return capChangedRows(collapseUnchangedRuns(opsToRows(context, MAX_CHANGED_ROWS / 2)));
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
