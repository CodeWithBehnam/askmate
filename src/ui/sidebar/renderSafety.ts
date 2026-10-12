/**
 * Render-time safety for the sidebar. The sanitiser itself lives in src/safety/sanitize.ts so write paths can share
 * it; it is re-exported here so existing imports keep working. This file keeps the helpers that classify the images
 * a context preview would load.
 */

import { isEscaped } from "../../safety/scan";

export {
	NEUTRAL_CODE_LANGUAGE,
	PLAIN_CODE_LANGUAGES,
	isSafeImageDestination,
	sanitizeModelMarkdown,
	sanitizeModelMarkdownDetailed,
	splitUnclosedMermaid
} from "../../safety/sanitize";
export type { MermaidFenceReport, SanitizeOptions, SanitizeResult } from "../../safety/sanitize";
export { classifyLinkDestination } from "../../safety/links";
export type { LinkKind } from "../../safety/links";
export { validateMermaidSource } from "../../safety/mermaidGuard";
export type { GuardResult, MermaidGuardOptions, MermaidGuardReason } from "../../safety/mermaidGuard";

/** Where a context image preview would load from. Only "vault" and "data" sources are ever displayed. */
export type ImagePreviewSourceKind = "vault" | "data" | "remote";

/** Image embed targets (`![[...]]` and `![alt](...)`) in document order. Plain links are not images and are ignored. */
export function extractImageEmbedTargets(markdown: string): string[] {
	const pattern = /!\[\[([^\]\n]+)\]\]|!\[[^\]\n]*\]\(([^)\n]*)\)/g;
	const targets: string[] = [];

	for (const match of markdown.matchAll(pattern)) {
		if (match.index !== undefined && isEscaped(markdown, match.index)) {
			continue;
		}
		const target = match[1] !== undefined
			? cleanImageTarget(match[1])
			: cleanImageTarget(stripLinkTitle(match[2] ?? ""));
		if (target) {
			targets.push(target);
		}
	}

	return targets;
}

export function classifyImagePreviewSource(target: string): ImagePreviewSourceKind {
	if (/^data:image\//i.test(target)) {
		return "data";
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("\\\\")) {
		return "remote";
	}
	return "vault";
}

/** A short caption for a data URI, so a multi-megabyte payload never ends up in alt text or captions. */
export function describeDataImage(target: string): string {
	const subtype = /^data:image\/([a-z0-9.+-]+)/i.exec(target)?.[1]?.toLowerCase();
	return subtype ? `Inline image (${subtype.replace(/\+xml$/, "")})` : "Inline image";
}

function stripLinkTitle(destination: string): string {
	const trimmed = destination.trim();
	if (trimmed.startsWith("<")) {
		const end = trimmed.indexOf(">");
		return end === -1 ? trimmed : trimmed.slice(1, end);
	}
	return trimmed.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/, "");
}

function cleanImageTarget(reference: string): string {
	let clean = reference.trim().replace(/^<(.+)>$/, "$1").replace(/^['"](.+)['"]$/, "$1").trim();
	if (/^data:/i.test(clean)) {
		return clean;
	}

	clean = clean.split("|")[0]?.split("#")[0]?.trim() ?? "";
	try {
		return decodeURI(clean);
	} catch {
		return clean;
	}
}
