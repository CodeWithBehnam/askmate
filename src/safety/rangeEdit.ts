export interface RangeEdit {
	/** Offset in the old text where the replaced range starts. */
	start: number;
	/** Offset in the old text where the replaced range ends. */
	end: number;
	/** Text that replaces the range. */
	insert: string;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The smallest single edit that turns `before` into `after`: everything the two share at the start and at the end
 * is left alone. Applied through an editor's replaceRange, it keeps the cursor, folds and undo history of the
 * untouched text, which a whole-note setValue throws away. Cut points never fall inside a surrogate pair.
 */
export function planRangeEdit(before: string, after: string): RangeEdit {
	const shortest = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
		prefix += 1;
	}
	if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1)) && (isLowSurrogate(before.charCodeAt(prefix)) || isLowSurrogate(after.charCodeAt(prefix)))) {
		prefix -= 1;
	}

	const room = shortest - prefix;
	let suffix = 0;
	while (suffix < room && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) {
		suffix += 1;
	}
	if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix)) && (isHighSurrogate(before.charCodeAt(before.length - suffix - 1)) || isHighSurrogate(after.charCodeAt(after.length - suffix - 1)))) {
		suffix -= 1;
	}

	return { start: prefix, end: before.length - suffix, insert: after.slice(prefix, after.length - suffix) };
}
