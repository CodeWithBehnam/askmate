/** What the safety passes found in model output, so callers can warn the user and tests can assert on it. */
export type FindingKind =
	| "remote-image"
	| "plugin-fence"
	| "dataview-inline"
	| "network-html"
	| "unsafe-diagram"
	| "blocked-link"
	| "template-tag"
	| "math-command"
	| "invisible-character"
	| "bidi-character"
	| "scan-limit";

export interface Finding {
	kind: FindingKind;
	/** Short sentence for the interface. */
	message: string;
	/** 1-based line in the text that was checked. */
	line: number;
	/** The construct as it appeared, clipped for display. Not an identity: two constructs can share their first characters. */
	excerpt: string;
	/**
	 * The whole construct (the full fence body, tag, destination, diagram source or template tag), which is what the
	 * write path compares to decide that the source text already held it. Null when the construct could not be read in
	 * full, in which case it is never treated as one the source held.
	 */
	identity: string | null;
}

const MAX_EXCERPT_CHARACTERS = 240;

export const FINDING_MESSAGES: Readonly<Record<FindingKind, string>> = {
	"remote-image": "A remote image was turned into a link, because loading it would send data to another site.",
	"plugin-fence": "A code block that another plugin could run was relabelled as plain text.",
	"dataview-inline": "A Dataview inline query was defused so it cannot run.",
	"network-html": "HTML that can load a resource or open a link was shown as text.",
	"unsafe-diagram": "A Mermaid diagram that could load a resource was shown as code.",
	"blocked-link": "A link that could trigger another app or plugin was shown as text.",
	"template-tag": "A Templater tag was defused so it cannot run.",
	"math-command": "A math command that can load a resource or open a link was defused.",
	"invisible-character": "Invisible characters were removed.",
	"bidi-character": "Text direction control characters were removed.",
	"scan-limit": "The reply was too complex to check in full, so images and HTML in the rest of it were shown as text."
};

export function clipExcerpt(text: string): string {
	return text.length <= MAX_EXCERPT_CHARACTERS ? text : text.slice(0, MAX_EXCERPT_CHARACTERS);
}

export interface FindingDetails {
	/** Replaces the standard sentence for the kind, for example to say why a diagram was rejected. */
	message?: string;
	/** The whole construct. Defaults to the unclipped excerpt, so pass it whenever the excerpt is only the start of the construct. */
	identity?: string | null;
}

export function createFinding(kind: FindingKind, line: number, excerpt: string, details: FindingDetails = {}): Finding {
	return {
		kind,
		message: details.message ?? FINDING_MESSAGES[kind],
		line,
		excerpt: clipExcerpt(excerpt),
		identity: details.identity === undefined ? excerpt : details.identity
	};
}

/** Identity of a construct for "the source already had this" comparisons, or null when it can never match. */
export function findingKey(finding: Finding): string | null {
	return finding.identity === null ? null : `${finding.kind}\u0000${finding.identity}`;
}
