// A conservative local check for diagram text. The plugin composes it with the allowlist guard in src/safety;
// the pipeline itself only depends on the SafetyCheck shape, so either can be injected.

import { splitHeader } from "./extract";
import type { SafetyOptions, SafetyVerdict } from "./types";

/** Constructs that fetch remote content, run code, or restyle the host. All are rejected, never rewritten. */
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
	[/^\s*(click|href|callback|links?)\s/m, "interaction directives (click, href, callback, link) are not allowed"],
	[/themeCSS|securityLevel|startOnLoad|maxTextSize|maxEdges/i, "security and global config keys are not allowed"],
	[/@import|url\s*\(|javascript:|\bdata:[\w.+-]+\/|\b(?:https?|ftp|wss?|file):|\/\/|&#|&sol;/i, "remote or script URLs are not allowed"],
	[/<\s*(script|iframe|img|object|embed|link|style|svg|foreignObject)\b/i, "raw HTML elements are not allowed"],
	[/\bimg\s*:/i, "image shapes are not allowed because they fetch remote images"],
	[/\bon(?:error|load|click|mouse\w*|focus|blur|key\w*|submit|change)\s*=/i, "inline event handlers are not allowed"],
	[/\bflowchart-elk\b|\blayout\s*:\s*elk\b/i, "this Obsidian build does not ship the ELK layout"]
];

const HEADER_REASON = "the diagram header is added by AskMate, so frontmatter and %% directives are not allowed";

export function localSafetyCheck(source: string, options: SafetyOptions): SafetyVerdict {
	const { header, rest } = splitHeader(source);
	const reasons = [
		...(header !== "" && !options.allowPluginHeader ? [HEADER_REASON] : []),
		...FORBIDDEN.filter(([pattern]) => pattern.test(options.allowPluginHeader ? rest : source)).map(([, message]) => message)
	];
	return { ok: reasons.length === 0, reasons };
}

