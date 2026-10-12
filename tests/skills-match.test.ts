import { describe, expect, test } from "bun:test";
import {
	BM25_B,
	BM25_K1,
	DEFAULT_MATCH_THRESHOLDS,
	EXAMPLE_SKILL_TEMPLATES,
	MATCH_IDF_CATALOGUE_FLOOR,
	MATCH_MAX_REQUEST_CHARS,
	MATCH_MIN_NAME_TERMS,
	MATCH_MIN_QUERY_TOKENS,
	MATCH_MIN_RATIO,
	MATCH_MIN_SCORE,
	MATCH_WEIGHTS,
	PHRASE_BONUS,
	decideMatch,
	hashSkillText,
	isExplainQuestion,
	loadBuiltInSkills,
	matchSkill,
	parseSkillFile,
	rankSkills,
	type MatchCandidate,
	type Skill
} from "../src/skills";

const parseYaml = (text: string): unknown => Bun.YAML.parse(text);

async function buildCatalogue(): Promise<Skill[]> {
	const builtIns = await loadBuiltInSkills(parseYaml, (text) => hashSkillText(text));
	const examples = await Promise.all(EXAMPLE_SKILL_TEMPLATES.map(async (template) => parseSkillFile({
		path: `AskMate/Skills/${template.path}`,
		raw: template.content,
		hash: await hashSkillText(template.content),
		source: "vault",
		fallbackName: template.id,
		parseYaml
	})));
	return [...builtIns, ...examples];
}

const catalogue = await buildCatalogue();
const toCandidates = (skills: readonly Skill[]): MatchCandidate[] => skills.map((skill) => ({ id: skill.name, manifest: skill.manifest }));
const FULL = toCandidates(catalogue);
const FRESH_INSTALL = toCandidates(catalogue.filter((skill) => skill.source === "built-in"));

/** [request, skill that must start, skill this is a near miss for]. A null skill means nothing may start. */
type Case = readonly [query: string, expected: string | null, nearMissOf?: string];

const MERMAID = "mermaid-diagrams";
const MINUTES = "meeting-minutes";
const ANKI = "anki-flashcards";
const WEEKLY = "weekly-review";
const CORNELL = "cornell-notes";
const TRANSLATE = "translate-keep-format";

/**
 * The 55 queries the matcher was designed against: 35 written first and 20 added later. They are kept verbatim, in
 * order, as the regression floor. Every one must come out right.
 */
const CORE_QUERIES: readonly Case[] = [
	["turn this note into a flowchart", MERMAID],
	["draw a diagram of how the pieces connect", MERMAID],
	["can you visualise the onboarding process", MERMAID],
	["make a mind map of my reading notes", MERMAID],
	["sequence diagram of the login flow between app, API and database", MERMAID],
	["fix the syntax error in my mermaid block", MERMAID],
	["gantt chart for the project plan above", MERMAID],
	["ER diagram for the tables I described", MERMAID],
	["map out the cause and effect in this essay visually", MERMAID],
	["give me a timeline diagram of the events", MERMAID],
	["make this diagram look nicer, left to right, and colour the decision nodes", MERMAID],
	["Create a Mermaid diagram from this note.", MERMAID],
	["draw the architecture", MERMAID],
	["org chart of the team listed here", MERMAID],
	["show me the relationships between the people mentioned as a graph", MERMAID],
	["diagram", MERMAID],
	["summarise this note in five bullets", null],
	["what does the diagram in this note show?", null, MERMAID],
	["make a table of pros and cons", null],
	["write a timeline of my week as a bulleted list", null, MERMAID],
	["generate an image of a lighthouse at dusk", null],
	["rewrite the intro paragraph to be punchier", null],
	["fix the typos", null],
	["explain the flow of control in this code", null, MERMAID],
	["plan my project", null],
	["what's the difference between a flowchart and a sequence diagram?", null, MERMAID],
	["list the action items from today's meeting", MINUTES],
	["convert this meeting transcript to minutes with decisions and owners", MINUTES],
	["turn these into anki flashcards", ANKI],
	["quiz me on this note", ANKI],
	["what did I do this week based on my daily notes", WEEKLY],
	["Make a weekly review", WEEKLY],
	["cornell notes for this chapter", CORNELL],
	["translate this into French and keep the formatting", TRANSLATE],
	["translate this to Spanish", TRANSLATE],
	["sketch a flow for how a support ticket is handled", MERMAID],
	["I need a class diagram for these entities", MERMAID],
	["convert the steps above into a Mermaid flowchart top-down", MERMAID],
	["redraw this as a state diagram", MERMAID],
	["create a gantt for the Q4 launch", MERMAID],
	["make a swimlane of who does what", MERMAID],
	["add a legend and colours to my mermaid diagram", MERMAID],
	["turn the bullet list into a mindmap", MERMAID],
	["list the steps of the process in order", null, MERMAID],
	["what are the main entities in this note?", null, MERMAID],
	["turn this into a table", null],
	["give me a one line summary", null],
	["how do I draw a diagram in Obsidian?", null, MERMAID],
	["which entities relate to each other in this schema?", null, MERMAID],
	["create flashcards from this", ANKI],
	["recap the meeting and list owners", MINUTES],
	["translate the headings only", TRANSLATE],
	["write a haiku about autumn", null],
	["is this a good flowchart?", null, MERMAID],
	["review my week", WEEKLY]
];

/**
 * Added so every skill has at least eight requests it must start on and eight near misses it must leave alone.
 * A near miss shares the skill's vocabulary but asks something else: a question, a how-to, a negation, or one
 * stray word. These were written after the matcher, so they check coverage, not generalisation.
 */
const SUPPLEMENTARY_QUERIES: readonly Case[] = [
	["draw conclusions from the research in this note", null, MERMAID],
	["don't make a diagram, just describe it in words", null, MERMAID],
	["explain what a swimlane is", null, MERMAID],
	["map the Spanish verbs to their English meanings", null, MERMAID],
	["can you diagram how the heart pumps blood?", MERMAID],
	["show the dependencies between these modules as a flowchart", MERMAID],
	["generate a mermaid sequence diagram for checkout", MERMAID],
	["a state diagram for the order lifecycle please", MERMAID],
	["explain the login process as a flowchart", MERMAID],
	["what would the plan look like? draw it as a gantt", MERMAID],

	["write up the minutes of today's team meeting", MINUTES],
	["extract action items and decisions from this transcript", MINUTES],
	["summarise the stand-up notes with owners for each task", MINUTES],
	["meeting recap for the product sync, with decisions and owners", MINUTES],
	["clean up my meeting notes into minutes", MINUTES],
	["when is the next team meeting?", null, MINUTES],
	["schedule a meeting with Anna next week", null, MINUTES],
	["add the meeting to my calendar", null, MINUTES],
	["how long should a meeting last?", null, MINUTES],
	["prepare an agenda for tomorrow's meeting", null, MINUTES],
	["write a polite email declining the meeting invite", null, MINUTES],
	["what does this action item mean?", null, MINUTES],
	["list the pros and cons of daily stand-ups", null, MINUTES],

	["make flashcards from the vocabulary list", ANKI],
	["create anki cards for chapter 3", ANKI],
	["quiz me on the key dates", ANKI],
	["turn these definitions into cloze deletions", ANKI],
	["I want spaced repetition cards for this biology note", ANKI],
	["generate 20 flash cards", ANKI],
	["what is spaced repetition?", null, ANKI],
	["how does anki schedule reviews?", null, ANKI],
	["explain the cloze test in linguistics", null, ANKI],
	["is flashcard studying effective?", null, ANKI],
	["what are good flashcard apps?", null, ANKI],
	["my flash drive is full", null, ANKI],
	["don't make flashcards, just summarise the chapter", null, ANKI],
	["write an essay about memory and learning", null, ANKI],

	["weekly review of my daily notes from the last seven days", WEEKLY],
	["do a monthly review for September", WEEKLY],
	["what did I do this week?", WEEKLY],
	["run a retrospective on this sprint", WEEKLY],
	["write my weekly review with wins and lessons", WEEKLY],
	["review my week and tell me what to focus on next", WEEKLY],
	["what is a weekly review?", null, WEEKLY],
	["when should I do my weekly review?", null, WEEKLY],
	["review the grammar in this paragraph", null, WEEKLY],
	["review my code for bugs", null, WEEKLY],
	["plan my week", null, WEEKLY],
	["what's on my calendar this week?", null, WEEKLY],
	["add a task to my weekly planner", null, WEEKLY],
	["write a monthly newsletter intro", null, WEEKLY],

	["cornell notes for this lecture", CORNELL],
	["reformat my chapter notes using the cornell method", CORNELL],
	["make cornell style notes from this article", CORNELL],
	["add a cue column to these notes", CORNELL],
	["organise this lecture as cornell notes with a summary", CORNELL],
	["turn my study notes into the cornell method format", CORNELL],
	["cornell notes please", CORNELL],
	["convert this to cornell notes", CORNELL],
	["who invented the cornell method?", null, CORNELL],
	["what is a cue column?", null, CORNELL],
	["how do I take good study notes?", null, CORNELL],
	["summarise this chapter", null, CORNELL],
	["tell me about cornell university", null, CORNELL],
	["list the colleges at cornell university", null, CORNELL],
	["make a two column table of terms and definitions", null, CORNELL],
	["give me revision tips", null, CORNELL],

	["translate the whole note into German", TRANSLATE],
	["please translate this to French but keep the links", TRANSLATE],
	["I need a Spanish translation of this page", TRANSLATE],
	["translate this into french", TRANSLATE],
	["translate each heading into Spanish and keep the table", TRANSLATE],
	["translate my notes", TRANSLATE],
	["what does translate mean in this code?", null, TRANSLATE],
	["how do I translate a Word document?", null, TRANSLATE],
	["is Google Translate accurate?", null, TRANSLATE],
	["explain how translation memory works", null, TRANSLATE],
	["check the grammar of this paragraph", null, TRANSLATE],
	["don't translate anything, just proofread", null, TRANSLATE],
	["why is the Spanish version of this note shorter?", null, TRANSLATE],
	["list the languages mentioned in this note", null, TRANSLATE],
	["fix the French accents in this paragraph", null, TRANSLATE]
];

const ALL_QUERIES: readonly Case[] = [...CORE_QUERIES, ...SUPPLEMENTARY_QUERIES];

function outcome(request: string, candidates: readonly MatchCandidate[] = FULL): string | null {
	const decision = matchSkill(request, candidates);
	return decision.kind === "match" ? decision.id : null;
}

describe("skill matcher fixture", () => {
	test("the core fixture holds exactly the 55 queries it was built from", () => {
		expect(CORE_QUERIES).toHaveLength(55);
		expect(new Set(CORE_QUERIES.map(([query]) => query)).size).toBe(55);
	});

	test("finds every positive, starts nothing on a negative, with the full starter catalogue", () => {
		const wrong = ALL_QUERIES
			.map(([query, expected]) => ({ query, expected, got: outcome(query) }))
			.filter((row) => row.got !== row.expected);
		expect(wrong).toEqual([]);
	});

	test("the 55 core queries pass on their own", () => {
		const wrong = CORE_QUERIES.filter(([query, expected]) => outcome(query) !== expected).map(([query]) => query);
		expect(wrong).toEqual([]);
	});

	test("on a fresh install with only the built-in skill, its requests still match and nothing else does", () => {
		const wrong = ALL_QUERIES
			.map(([query, expected]) => ({ query, expected: expected === MERMAID ? MERMAID : null, got: outcome(query, FRESH_INSTALL) }))
			.filter((row) => row.got !== row.expected);
		expect(wrong).toEqual([]);
	});

	test("every skill has at least 8 positives and 8 near misses", () => {
		for (const skill of FULL) {
			const name = skill.id;
			const positives = ALL_QUERIES.filter(([, expected]) => expected === name).length;
			const nearMisses = ALL_QUERIES.filter(([, expected, nearMissOf]) => expected === null && nearMissOf === name).length;
			expect({ name, enough: positives >= 8 }).toEqual({ name, enough: true });
			expect({ name, enough: nearMisses >= 8 }).toEqual({ name, enough: true });
		}
	});

	test("no near miss or unrelated request is claimed by any skill, individually", () => {
		for (const candidate of FULL) {
			for (const [query, expected] of ALL_QUERIES) {
				if (expected === null) {
					expect({ skill: candidate.id, query, got: outcome(query, [candidate]) }).toEqual({ skill: candidate.id, query, got: null });
				}
			}
		}
	});
});

describe("skill matcher guards", () => {
	test("thresholds are named constants that the default decision uses", () => {
		expect(DEFAULT_MATCH_THRESHOLDS).toEqual({ minScore: MATCH_MIN_SCORE, minRatio: MATCH_MIN_RATIO, minQueryTokens: MATCH_MIN_QUERY_TOKENS });
		expect([BM25_K1, BM25_B, PHRASE_BONUS, MATCH_IDF_CATALOGUE_FLOOR, MATCH_MAX_REQUEST_CHARS]).toEqual([1.2, 0.75, 6, 6, 400]);
		expect(MATCH_WEIGHTS).toEqual({ name: 3, triggers: 3, text: 1 });
	});

	test("raising the floor turns a match into a rejection with a reason", () => {
		const request = "turn this note into a flowchart";
		const ranked = rankSkills(request, FULL);
		expect(decideMatch(request, ranked).kind).toBe("match");
		const raised = decideMatch(request, ranked, { ...DEFAULT_MATCH_THRESHOLDS, minScore: 1000 });
		expect(raised).toMatchObject({ kind: "none", code: "below-floor" });
	});

	test("one loose name word is never enough, even with no score floor", () => {
		const open = { ...DEFAULT_MATCH_THRESHOLDS, minScore: 0 };
		for (const request of ["review my code for bugs", "prepare an agenda for tomorrow's meeting", "list the colleges at cornell university"]) {
			expect(matchSkill(request, FULL, open)).toMatchObject({ kind: "none", code: "weak-signal" });
		}
		expect(MATCH_MIN_NAME_TERMS).toBe(2);
	});

	test("a strong signal is required even when the score is high", () => {
		const candidates: MatchCandidate[] = [{
			id: "loose",
			manifest: { name: "loose-skill", description: "Handles garden planning budgets schedules vegetables seasons soil", whenToUse: "", triggers: [] }
		}];
		const request = "garden planning budgets schedules vegetables seasons soil";
		const [top] = rankSkills(request, candidates);
		expect(top?.score ?? 0).toBeGreaterThan(MATCH_MIN_SCORE);
		expect(matchSkill(request, candidates)).toMatchObject({ kind: "none", code: "weak-signal" });
	});

	test("two skills that fit equally make the request ambiguous", () => {
		const twin = (id: string): MatchCandidate => ({
			id,
			manifest: { name: id, description: "Draws charts for the user", whenToUse: "", triggers: ["draw chart"] }
		});
		expect(matchSkill("draw chart of sales", [twin("alpha"), twin("beta")])).toMatchObject({ kind: "none", code: "ambiguous" });
	});

	test("only the start of a long request is matched", () => {
		const filler = "The following passage is pasted for context and is not a request. ".repeat(10);
		expect(filler.length).toBeGreaterThan(MATCH_MAX_REQUEST_CHARS);
		expect(outcome(`${filler} diagram`)).toBeNull();
		expect(outcome("diagram ".concat(filler))).toBe(MERMAID);
	});

	test("a negated clause cannot start a skill, but the rest of the request still counts", () => {
		expect(outcome("without a diagram, summarise the note")).toBeNull();
		expect(outcome("do not translate it, draw a flowchart instead")).toBe(MERMAID);
		expect(outcome("never mind the flashcards, make a mind map")).toBe(MERMAID);
	});

	test("questions are not requests, unless the skill itself is written as a question", () => {
		expect(isExplainQuestion("what is a flowchart")).toBe(true);
		expect(isExplainQuestion("how do I make a diagram")).toBe(true);
		expect(isExplainQuestion("What would a diagram of this look like? Draw it")).toBe(false);
		expect(isExplainQuestion("please explain the plot")).toBe(true);
		expect(outcome("what did I do this week")).toBe(WEEKLY);
	});

	test("an empty or filler-only request matches nothing", () => {
		expect(matchSkill("", FULL)).toMatchObject({ kind: "none", code: "too-short" });
		expect(matchSkill("the of and", FULL)).toMatchObject({ kind: "none", code: "too-short" });
	});

	test("ranking is deterministic and ties break on id", () => {
		const twin = (id: string): MatchCandidate => ({ id, manifest: { name: "same", description: "same words here", whenToUse: "", triggers: ["same words"] } });
		const first = rankSkills("same words", [twin("b"), twin("a"), twin("c")]).map((match) => match.id);
		const second = rankSkills("same words", [twin("c"), twin("a"), twin("b")]).map((match) => match.id);
		expect(first).toEqual(["a", "b", "c"]);
		expect(second).toEqual(first);
	});

	test("British and American spellings and word endings meet in the middle", () => {
		const request = "please visualize the colour scheme";
		const [top] = rankSkills(request, FULL);
		expect(top?.id).toBe(MERMAID);
		expect(outcome("translating this note into german")).toBe(TRANSLATE);
		expect(outcome("flashcard time")).toBe(ANKI);
	});

	test("non-English, emoji and very long requests are handled without error and match nothing by accident", () => {
		for (const request of ["یک نمودار برای این یادداشت بکش", "日本語のフローチャートを作って", "😀".repeat(2000), "a ".repeat(50_000), "\u0000\u0001"]) {
			expect(() => matchSkill(request, FULL)).not.toThrow();
			expect(outcome(request)).toBeNull();
		}
		expect(outcome("Café menu as a flowchart, please")).toBe(MERMAID);
	});

	test("a trigger written in another language matches that language", () => {
		const candidates: MatchCandidate[] = [{
			id: "persian",
			manifest: { name: "persian-notes", description: "Summarises Persian notes", whenToUse: "", triggers: ["خلاصه کن"] }
		}];
		expect(matchSkill("این یادداشت را خلاصه کن", candidates)).toMatchObject({ kind: "match", id: "persian" });
	});

	test("an empty catalogue ranks nothing", () => {
		expect(rankSkills("diagram", [])).toEqual([]);
		expect(matchSkill("diagram", [])).toMatchObject({ kind: "none", code: "no-overlap" });
	});
});
