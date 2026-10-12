const ILLEGAL_FILE_NAME_CHARACTERS = /[\\/:*?"<>|#^[\]]/g;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
// Zero-width, bidi override and tag characters have no place in a file name, and a right-to-left override can make
// the real extension look like something else in the file explorer.
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * Most file systems limit one name to 255 bytes, not characters. The base name leaves room for the stamp (16 bytes),
 * an attempt suffix and an extension.
 */
const MAX_BASE_NAME_BYTES = 200;

function utf8Length(codePoint: number): number {
	if (codePoint < 0x80) {
		return 1;
	}
	if (codePoint < 0x800) {
		return 2;
	}
	return codePoint < 0x10000 ? 3 : 4;
}

/**
 * Makes one vault path segment from free text such as a title or model output. Leading dots are removed because
 * Obsidian does not index hidden files, trailing dots and spaces because Windows rejects them, invisible and bidi
 * format characters are dropped, and the length is capped both in code points (so an emoji is never split into an
 * invalid surrogate) and in UTF-8 bytes (so a CJK or emoji title still fits the file system's name limit).
 */
export function sanitizeFileName(name: string, fallback = "AskMate Response", maxLength = 80, maxBytes = MAX_BASE_NAME_BYTES): string {
	const clean = name
		.replace(CONTROL_CHARACTERS, " ")
		.replace(FORMAT_CHARACTERS, "")
		.replace(ILLEGAL_FILE_NAME_CHARACTERS, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+/, "");
	const kept: string[] = [];
	let byteCount = 0;
	for (const char of clean) {
		const size = utf8Length(char.codePointAt(0) ?? 0);
		if (kept.length >= maxLength || byteCount + size > maxBytes) {
			break;
		}
		kept.push(char);
		byteCount += size;
	}
	return kept.join("").replace(/[.\s]+$/, "") || fallback;
}

/** Template values such as an image prompt are inserted into folder templates, so they must not add segments. */
export function sanitizePathTemplateValue(value: string): string {
	return sanitizeFileName(value, "");
}

export function sanitizePathTemplateValues(variables: Readonly<Record<string, string>>, keys: readonly string[]): Record<string, string> {
	return {
		...variables,
		...Object.fromEntries(keys.map((key) => [key, sanitizePathTemplateValue(variables[key] ?? "")]))
	};
}

export function buildUniquePathCandidate(folder: string, baseName: string, stamp: string, extension: string, attempt: number): string {
	const safeExtension = extension.replace(/^\.+/, "");
	const basePath = folder ? `${folder}/${baseName} ${stamp}` : `${baseName} ${stamp}`;
	return attempt <= 1 ? `${basePath}.${safeExtension}` : `${basePath} ${attempt}.${safeExtension}`;
}

/** macOS and Windows vaults are usually case-insensitive, so "Note.md" and "note.md" collide on disk. */
export function hasPathIgnoringCase(path: string, existingPaths: Iterable<string>): boolean {
	const target = path.toLowerCase();
	for (const existing of existingPaths) {
		if (existing.toLowerCase() === target) {
			return true;
		}
	}
	return false;
}

export function getParentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}
