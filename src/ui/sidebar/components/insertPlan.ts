import { assessModelMarkdownRisk } from "../../../safety";
import { describeIncompleteReason, isInsertable, prepareInsertText, type LastAnswer } from "../answerActions";

/**
 * What Insert at cursor writes. A reply is model text, and text written into a note outlives the sidebar: another plugin
 * can run what is in it long after. So the text is checked first; a clean reply goes in as it is, and a reply with
 * active content is offered in a safe version, as written, or not at all.
 */

/**
 * A reply as Insert sees it: the raw text, and what is known about a diagram in it. A diagram that AskMate drew carries
 * its own strict header, which the strict check would otherwise count as hidden frontmatter and turn the fence to text.
 */
export interface InsertableReply extends LastAnswer {
	/** "drawn" for a diagram that rendered (or was repaired); "fallback" for one that did not. Absent for any other reply. */
	diagram?: "drawn" | "fallback";
}

export type InsertPlan =
	| { kind: "none" }
	| { kind: "plain"; text: string }
	| { kind: "risky"; original: string; safe: string; findings: string[] };

const MAX_FINDINGS_LISTED = 5;

export function planAnswerInsert(answer: InsertableReply | null): InsertPlan {
	if (!isInsertable(answer)) {
		return { kind: "none" };
	}
	const text = prepareInsertText(answer.text);
	// Only a diagram that drew is trusted to carry the plugin header, and the closed-schema guard still checks it. A
	// diagram that did not draw is held to the strict rules, so it goes in as text or is not inserted.
	const risk = assessModelMarkdownRisk(text, answer.diagram === "drawn" ? { allowPluginMermaidHeader: true } : {});
	if (!risk.risky) {
		return { kind: "plain", text };
	}
	// One sentence per kind of problem, so ten remote images are one line, not ten.
	const findings = Array.from(new Set(risk.findings.map((finding) => finding.message))).slice(0, MAX_FINDINGS_LISTED);
	return { kind: "risky", original: text, safe: prepareInsertText(risk.safeText), findings };
}

export function describeInserted(targetLabel: string, answer: LastAnswer, options: { safeVersion?: boolean } = {}): string {
	const where = targetLabel ? ` in ${targetLabel}` : "";
	const base = options.safeVersion ? `Inserted a safe version at the cursor${where}.` : `Inserted at the cursor${where}.`;
	return answer.incompleteReason
		? `${base} This reply may be incomplete: ${describeIncompleteReason(answer.incompleteReason)}.`
		: base;
}
