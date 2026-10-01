const ILLEGAL_FILE_NAME_CHARACTERS = /[\\/:*?"<>|#^[\]]/g;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * Makes one vault path segment from free text such as a title or model output. Leading dots are removed because
 * Obsidian does not index hidden files, trailing dots and spaces because Windows rejects them, and the length is
 * counted in code points so an emoji is never split into an invalid surrogate.
 */
export function sanitizeFileName(name: string, fallback = "AskMate Response", maxLength = 80): string {
	const clean = name
		.replace(CONTROL_CHARACTERS, " ")
		.replace(ILLEGAL_FILE_NAME_CHARACTERS, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+/, "");
	const limited = Array.from(clean).slice(0, maxLength).join("").replace(/[.\s]+$/, "");
	return limited || fallback;
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
