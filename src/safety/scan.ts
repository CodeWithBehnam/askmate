/** Small text helpers shared by the safety scanners. */

/** True when the character at `index` is preceded by an odd number of backslashes. */
export function isEscaped(text: string, index: number): boolean {
	let backslashes = 0;
	for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
		backslashes += 1;
	}
	return backslashes % 2 === 1;
}

/** Length of the run of `char` that starts at `index`. */
export function countRun(text: string, index: number, char: string): number {
	let end = index;
	while (text[end] === char) {
		end += 1;
	}
	return end - index;
}

export function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/** Width of leading whitespace in columns, with tab stops every four columns as CommonMark counts them. */
export function indentWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		if (char === " ") {
			width += 1;
		} else if (char === "\t") {
			width += 4 - (width % 4);
		} else {
			break;
		}
	}
	return width;
}

/**
 * A work budget for scanners that re-read the same text from many starting points. Each scan spends the characters
 * it reads; once the budget is gone the caller must stop scanning and fail closed, so crafted input cannot make the
 * total work quadratic.
 */
export interface ScanBudget {
	/** Spends `units`; returns false once the budget is exhausted. */
	spend(units: number): boolean;
	readonly exhausted: boolean;
}

export function createScanBudget(limit: number): ScanBudget {
	let remaining = limit;
	return {
		spend(units: number): boolean {
			remaining -= Math.max(1, units);
			return remaining >= 0;
		},
		get exhausted(): boolean {
			return remaining < 0;
		}
	};
}

/**
 * `indexOf` for a needle that is searched from many increasing start positions. The last answer is reused while it
 * still holds, so a run of searches that all find the same distant match reads the text once.
 */
export function createNextIndexOf(text: string, needle: string): (from: number) => number {
	let cachedFrom = 0;
	let cachedIndex: number | null = null;
	return (from) => {
		if (cachedIndex !== null && from >= cachedFrom && (cachedIndex === -1 || from <= cachedIndex)) {
			return cachedIndex;
		}
		cachedFrom = from;
		cachedIndex = text.indexOf(needle, from);
		return cachedIndex;
	};
}

/** Line start offsets of `text`, for turning an offset into a 1-based line number. */
export function computeLineStarts(text: string): number[] {
	const starts = [0];
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		starts.push(index + 1);
	}
	return starts;
}

/** 1-based line containing `offset`, by binary search over `lineStarts`. */
export function lineNumberAt(lineStarts: readonly number[], offset: number): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (lineStarts[middle] <= offset) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	return low + 1;
}
