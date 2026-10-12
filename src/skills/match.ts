import type { SkillManifest } from "./types";
import { tokenise } from "./tokens";

/*
 * Deterministic skill matcher. No model call, no network: BM25F over a skill's name, trigger phrases and
 * description, then a stack of guards so generic wording never starts a skill. The score alone is not the safety;
 * a match must also carry a strong signal, survive the question and negation checks, and clearly beat the
 * runner-up. The thresholds below are tuned against tests/skills-match.test.ts and are named so they can be
 * revisited in one place.
 */

/** How much a term counts when it appears in each field. */
export const MATCH_WEIGHTS = { name: 3, triggers: 3, text: 1 } as const;
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
/** Added once per trigger phrase found as a contiguous run in the request. */
export const PHRASE_BONUS = 6;
/** Lowest total score that may start a skill. A single phrase trigger clears it on its own. */
export const MATCH_MIN_SCORE = 4;
/** The best skill must score at least this many times the runner-up, or the request is ambiguous. */
export const MATCH_MIN_RATIO = 1.5;
export const MATCH_MIN_QUERY_TOKENS = 1;
/** Matching terms a skill-name word needs behind it to count as a strong signal when no trigger phrase matched. */
export const MATCH_MIN_NAME_TERMS = 2;
/** Only the start of a request is matched, so a long pasted text cannot trigger a skill by accident. */
export const MATCH_MAX_REQUEST_CHARS = 400;
/**
 * IDF is computed as if the catalogue held at least this many skills. Without the floor a tiny catalogue (the one
 * built-in skill on a fresh install) gives every term near-zero weight and nothing would ever match.
 */
export const MATCH_IDF_CATALOGUE_FLOOR = 6;

export interface MatchThresholds {
	minScore: number;
	minRatio: number;
	minQueryTokens: number;
}

export const DEFAULT_MATCH_THRESHOLDS: MatchThresholds = {
	minScore: MATCH_MIN_SCORE,
	minRatio: MATCH_MIN_RATIO,
	minQueryTokens: MATCH_MIN_QUERY_TOKENS
};

export interface MatchCandidate {
	id: string;
	manifest: Pick<SkillManifest, "name" | "description" | "whenToUse" | "triggers">;
}

export interface Match {
	id: string;
	score: number;
	/** A whole trigger phrase matched, or a skill-name word with a second matching word. Loose word overlap alone is never enough. */
	strong: boolean;
	/** A trigger written as a question matched, so the "reads as a question" gate does not apply. */
	interrogativeHit: boolean;
	why: string[];
}

export type MatchRejection = "too-short" | "question" | "no-overlap" | "weak-signal" | "below-floor" | "ambiguous";

export type MatchDecision =
	| { kind: "match"; id: string; score: number; reason: string }
	| { kind: "none"; code: MatchRejection; reason: string; score?: number };

const EXPLAIN_LEAD = /^\s*(?:what|why|how|when|where|who|which|explain|describe|define|tell me|is|are|does|did|do (?:you|i|we|they)|can you explain|could you explain)\b/i;
const HOW_TO_LEAD = /^\s*(?:how (?:do|can|to|would|should|does|did)|can i|could i|is it possible|what is the best way)\b/i;
const ACTION_VERBS = "make|create|draw|redraw|generate|turn|convert|build|produce|show me|give me|fix|repair|restyle|redo|add|extend|map|sketch|plot|visuali[sz]e|translate|list|write|draft|outline|summari[sz]e|recap|prepare|extract|quiz|reformat";
/** An instruction that follows the question: "What would that look like? Draw it." or "Explain this, then make a table." */
const FOLLOW_UP_REQUEST = new RegExp(`(?:[?.!;,]|\\b(?:and|then)\\b)\\s*(?:please\\s+)?(?:${ACTION_VERBS})\\b`, "i");
/** An output format named with an article: "Explain the login flow as a flowchart." */
const FORMAT_CUE = /\b(?:as|into|in the form of)\s+(?:a|an|the)\b/i;
const POLITE_PREFIX = /^\s*(?:please|hey|hi|hello|ok|okay|so|now|then|and)\b[,\s]*/i;
/** A negation cue and the clause it governs, up to the next punctuation mark. */
const NEGATED_CLAUSE = /\b(?:don't|dont|do not|never|without|instead of|rather than|skip|no need (?:for|to)|not (?:a|an|the|any))\b[^.,;:!?\n]{0,40}/gi;

function withoutPoliteness(request: string): string {
	let current = request;
	for (let pass = 0; pass < 3; pass += 1) {
		const next = current.replace(POLITE_PREFIX, "");
		if (next === current) {
			break;
		}
		current = next;
	}
	return current;
}

/**
 * True when the request reads as a question about something rather than a request to produce it. A how-to question
 * always counts. A question lead ("what", "explain") counts unless an instruction or a named output format follows,
 * so "what does translate mean?" is a question while "Explain the flow as a flowchart" is not.
 */
export function isExplainQuestion(request: string): boolean {
	const lead = withoutPoliteness(request);
	if (HOW_TO_LEAD.test(lead)) {
		return true;
	}
	return EXPLAIN_LEAD.test(lead) && !FOLLOW_UP_REQUEST.test(lead) && !FORMAT_CUE.test(lead);
}

/** Keeps the start of the request and drops clauses the user negated ("without a diagram"), so they cannot match. */
export function prepareRequest(request: string): string {
	return request
		.slice(0, MATCH_MAX_REQUEST_CHARS)
		.replace(new RegExp("[\\u2018\\u2019]", "g"), "'")
		.replace(NEGATED_CLAUSE, " ");
}

interface Doc {
	id: string;
	tf: Map<string, number>;
	length: number;
	nameTokens: Set<string>;
	phrases: Array<{ tokens: string[]; interrogative: boolean }>;
}

function buildDoc(candidate: MatchCandidate): Doc {
	const tf = new Map<string, number>();
	const add = (tokens: string[], weight: number): void => {
		for (const token of tokens) {
			tf.set(token, (tf.get(token) ?? 0) + weight);
		}
	};
	const { manifest } = candidate;
	const nameTokens = tokenise(manifest.name.replace(/-/g, " "));
	add(nameTokens, MATCH_WEIGHTS.name);
	add(manifest.triggers.flatMap((trigger) => tokenise(trigger)), MATCH_WEIGHTS.triggers);
	add(tokenise(`${manifest.description} ${manifest.whenToUse}`), MATCH_WEIGHTS.text);
	let length = 0;
	tf.forEach((value) => {
		length += value;
	});
	return {
		id: candidate.id,
		tf,
		length,
		nameTokens: new Set(nameTokens),
		phrases: manifest.triggers
			.map((trigger) => ({ tokens: tokenise(trigger, true), interrogative: EXPLAIN_LEAD.test(trigger) }))
			.filter((phrase) => phrase.tokens.length > 0)
	};
}

function containsPhrase(haystack: readonly string[], phrase: readonly string[]): boolean {
	if (phrase.length === 0 || phrase.length > haystack.length) {
		return false;
	}
	for (let start = 0; start <= haystack.length - phrase.length; start += 1) {
		if (phrase.every((token, offset) => haystack[start + offset] === token)) {
			return true;
		}
	}
	return false;
}

/** Ranks candidates for a request, best first. Pure and deterministic; ties break on id. */
export function rankSkills(request: string, candidates: readonly MatchCandidate[]): Match[] {
	const docs = candidates.map(buildDoc);
	if (docs.length === 0) {
		return [];
	}
	const prepared = prepareRequest(request);
	const terms = Array.from(new Set(tokenise(prepared)));
	const phraseTokens = tokenise(prepared, true);
	const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
	const catalogueSize = Math.max(docs.length, MATCH_IDF_CATALOGUE_FLOOR);
	const idf = (term: string): number => {
		const containing = docs.filter((doc) => doc.tf.has(term)).length;
		return Math.log(1 + (catalogueSize - containing + 0.5) / (containing + 0.5));
	};
	return docs
		.map((doc): Match => {
			const why: string[] = [];
			let score = 0;
			let nameHit = false;
			let phraseHit = false;
			let interrogativeHit = false;
			for (const term of terms) {
				const frequency = doc.tf.get(term);
				if (!frequency) {
					continue;
				}
				score += idf(term) * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / averageLength))));
				why.push(term);
				nameHit = nameHit || doc.nameTokens.has(term);
			}
			const termHits = why.length;
			for (const phrase of doc.phrases) {
				if (containsPhrase(phraseTokens, phrase.tokens)) {
					score += PHRASE_BONUS;
					phraseHit = true;
					interrogativeHit = interrogativeHit || phrase.interrogative;
					why.push(`"${phrase.tokens.join(" ")}"`);
				}
			}
			// One loose word is never enough, whatever it scores: a whole trigger phrase, or a name word backed by a second matching word.
			const strong = phraseHit || (nameHit && termHits >= MATCH_MIN_NAME_TERMS);
			return { id: doc.id, score, strong, interrogativeHit, why };
		})
		.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

/** Applies the guards that keep an automatic match from firing on generic wording. */
export function decideMatch(request: string, ranked: readonly Match[], thresholds: MatchThresholds = DEFAULT_MATCH_THRESHOLDS): MatchDecision {
	if (tokenise(prepareRequest(request)).length < thresholds.minQueryTokens) {
		return { kind: "none", code: "too-short", reason: "The request is too short to match." };
	}
	const [top, second] = ranked;
	if (isExplainQuestion(request.slice(0, MATCH_MAX_REQUEST_CHARS)) && !top?.interrogativeHit) {
		return { kind: "none", code: "question", reason: "The request reads as a question, not a request to produce something." };
	}
	if (!top || top.score <= 0) {
		return { kind: "none", code: "no-overlap", reason: "No skill shares words with the request." };
	}
	if (!top.strong) {
		return { kind: "none", code: "weak-signal", reason: "No trigger phrase or skill name word matched.", score: top.score };
	}
	if (top.score < thresholds.minScore) {
		return { kind: "none", code: "below-floor", reason: "The best match scored below the minimum.", score: top.score };
	}
	if (second && second.score > 0 && top.score / second.score < thresholds.minRatio) {
		return { kind: "none", code: "ambiguous", reason: "The request fits more than one skill about equally.", score: top.score };
	}
	return { kind: "match", id: top.id, score: top.score, reason: `matched ${top.why.join(", ")}` };
}

/** Ranks and decides in one step. */
export function matchSkill(request: string, candidates: readonly MatchCandidate[], thresholds: MatchThresholds = DEFAULT_MATCH_THRESHOLDS): MatchDecision {
	return decideMatch(request, rankSkills(request, candidates), thresholds);
}
