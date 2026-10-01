import { MAX_CONTEXT_PATH_LENGTH } from "../../settings/constants";
import { hasUnsafePathSegment, normalizeOptionalString } from "../../settings/normalize";

export interface IntegerBounds {
	min: number;
	max: number;
}

export type IntegerInputResult =
	| { kind: "ignored" }
	| { kind: "accepted"; value: number; clamped: boolean };

export type BaseUrlInputResult =
	| { kind: "restore-default"; value: string }
	| { kind: "accepted"; value: string }
	| { kind: "invalid"; message: string };

export type FolderPathInputResult =
	| { kind: "accepted"; value: string }
	| { kind: "unsafe" };

/**
 * Empty or non-numeric input is ignored rather than saved as 0 or the minimum,
 * because 0 disables usage guardrails and a low minimum can shrink limits the user did not mean to change.
 */
export function resolveIntegerInput(raw: string, bounds: IntegerBounds): IntegerInputResult {
	const trimmed = raw.trim();
	const numeric = trimmed ? Number(trimmed) : NaN;
	if (!Number.isFinite(numeric)) {
		return { kind: "ignored" };
	}

	const rounded = Math.round(numeric);
	const value = Math.max(bounds.min, Math.min(bounds.max, rounded));
	return { kind: "accepted", value, clamped: value !== rounded };
}

export function formatIntegerRange(bounds: IntegerBounds): string {
	return `${bounds.min.toLocaleString("en-GB")} to ${bounds.max.toLocaleString("en-GB")}`;
}

/**
 * Mirrors the save-time folder normaliser, so the field can show the value that is kept
 * and refuse "." or ".." segments instead of letting the save silently replace them.
 */
export function resolveFolderPathInput(raw: string): FolderPathInputResult {
	const value = normalizeOptionalString(raw, MAX_CONTEXT_PATH_LENGTH);
	return hasUnsafePathSegment(value) ? { kind: "unsafe" } : { kind: "accepted", value };
}

/** An empty field is an explicit request for the default, so the caller can tell the user instead of saving it silently. */
export function resolveBaseUrlInput(raw: string, fallback: string, validate: (value: string, fallback: string) => string): BaseUrlInputResult {
	if (!raw.trim()) {
		return { kind: "restore-default", value: fallback };
	}

	try {
		return { kind: "accepted", value: validate(raw, fallback) };
	} catch (error) {
		return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
	}
}
