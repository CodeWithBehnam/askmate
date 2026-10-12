import { MAX_SKILL_NAME } from "./limits";
import { slugifySkillName } from "./parse";
import { renderSkillMarkdown, type SkillDefinition } from "./render";

/** A starter skill offered by "Install examples" and "New skill from template". */
export interface SkillTemplate {
	/** Same as the skill name. */
	id: string;
	title: string;
	summary: string;
	/** Path under the skills folder. */
	path: string;
	content: string;
}

/**
 * Written out here because nothing in src/skills may import from outside the folder. tests/skills-builtin.test.ts compares it
 * with TABLE_CELL_RULE in src/workflows/promptRules.ts, so the two cannot drift.
 */
const TABLE_CELL_RULE = "Keep each table cell on one line: write a pipe inside a cell as \\| (including the alias pipe in a wikilink, as in `[[Note\\|alias]]`) and use <br> for a line break.";

const EXAMPLES: readonly SkillDefinition[] = [
	{
		name: "meeting-minutes",
		title: "Meeting minutes",
		description: "Turns a meeting note or transcript into clear minutes with decisions, action items and owners. Use when the user asks for meeting minutes, action items, decisions, owners or a recap of a meeting, call or stand-up.",
		whenToUse: "The note is about a meeting, call or stand-up.",
		triggers: ["meeting minutes", "action items", "meeting notes", "meeting recap", "recap of the meeting", "stand-up notes", "decisions and owners"],
		version: "1.0.0",
		icon: "clipboard-list",
		body: [
			"# Goal",
			"Produce minutes that someone who missed the meeting can act on.",
			"",
			"# Success criteria",
			"- Decisions, action items and open questions are separate and easy to scan.",
			"- Every action item names an owner and a date when the note states them. Otherwise it says \"owner not stated\" or \"no date stated\".",
			"- Nothing is invented. Names, dates and decisions come from the note.",
			"",
			"# Output",
			"Use these sections in order and skip any that are empty: Summary (two sentences at most), Decisions, Action items (a checklist, one line each, as - [ ] task (owner, date)), Open questions.",
			"",
			"# Stop rules",
			"If the note is not about a meeting, say so in one sentence and ask what to produce instead."
		].join("\n")
	},
	{
		name: "anki-flashcards",
		title: "Anki flashcards",
		description: "Turns a note into question and answer flashcards for spaced repetition. Use when the user wants flashcards, Anki cards, cloze deletions or a quiz from a note.",
		whenToUse: "The user wants to memorise or be tested on the content of a note.",
		triggers: ["flashcards", "flash cards", "anki", "spaced repetition", "quiz me", "cloze"],
		version: "1.0.0",
		icon: "layers",
		body: [
			"# Goal",
			"Turn the note into flashcards that test one fact each.",
			"",
			"# Success criteria",
			"- Each card asks one thing and has one short, checkable answer.",
			"- Every card is answerable from the note alone. No outside facts.",
			"- Definitions, dates, formulas and cause and effect are covered before minor detail.",
			"",
			"# Output",
			"One card per line in the form question :: answer. If the user asks for cloze deletions, write one full sentence per card and mark the hidden words with Anki cloze syntax. Put no commentary around the cards.",
			"",
			"# Stop rules",
			"If the note has too little factual content for cards, say so in one sentence instead of padding."
		].join("\n")
	},
	{
		name: "weekly-review",
		title: "Weekly review",
		description: "Builds a weekly or monthly review from daily notes: wins, lessons, open loops and next focus. Use when the user wants a weekly review, monthly review, retrospective or a summary of what they did this week.",
		whenToUse: "The context holds daily notes or a log for a week or month.",
		triggers: ["weekly review", "monthly review", "what did i do this week", "review my week", "retrospective"],
		version: "1.0.0",
		icon: "calendar-check",
		body: [
			"# Goal",
			"Give the writer an honest picture of the period and a clear next focus.",
			"",
			"# Success criteria",
			"- Wins and lessons are specific and traceable to entries in the notes.",
			"- Open loops are tasks started but not finished, each with the day it first appeared.",
			"- The next focus has three items at most.",
			"",
			"# Output",
			"Sections in order: Wins, Lessons, Open loops, Next focus. Use short bullets and the dates the notes use.",
			"",
			"# Stop rules",
			"If the notes cover less than two days, say so and review only what exists."
		].join("\n")
	},
	{
		name: "cornell-notes",
		title: "Cornell notes",
		description: "Reformats study material as Cornell notes with a cue column, main notes and a summary. Use when the user wants Cornell style study notes.",
		whenToUse: "The user is studying a chapter, lecture or article.",
		triggers: ["cornell notes", "cornell method", "cue column"],
		version: "1.0.0",
		icon: "graduation-cap",
		body: [
			"# Goal",
			"Reshape the material into Cornell notes the user can revise from.",
			"",
			"# Success criteria",
			"- Each cue is a question or keyword that prompts recall of the notes beside it.",
			"- The notes keep the source's meaning and terms. Nothing is added.",
			"- The summary is two or three sentences in the user's likely own words.",
			"",
			"# Output",
			`A two-column Markdown table with the header Cue | Notes, then a Summary heading and the summary. ${TABLE_CELL_RULE}`,
			"",
			"# Stop rules",
			"If the material is shorter than a paragraph, say so and ask for more instead of stretching it."
		].join("\n")
	},
	{
		name: "translate-keep-format",
		title: "Translate and keep format",
		description: "Translates a note into another language while keeping Markdown structure, links, code and terminology. Use when the user wants a note translated.",
		whenToUse: "The user names a target language or asks for a translation.",
		triggers: ["translate", "translation", "into french", "into spanish", "into german", "to spanish", "to french"],
		version: "1.0.0",
		icon: "languages",
		body: [
			"# Goal",
			"Deliver a faithful translation that can replace the original note without repair.",
			"",
			"# Success criteria",
			"- Meaning, tone, names, numbers and terminology are preserved.",
			"- Headings, lists, tables, links, wikilinks, code and front matter keep their structure. Only prose is translated.",
			"- Terms with no good equivalent stay in the source language with a short gloss on first use.",
			"",
			"# Output",
			"Only the translated note, with no preface.",
			"",
			"# Stop rules",
			"If the target language is not stated, ask which one before translating."
		].join("\n")
	}
];

const BLANK_BODY = [
	"# Goal",
	"Describe the result the user should get, in one or two sentences.",
	"",
	"# Success criteria",
	"- What must be true before the answer is complete.",
	"",
	"# Constraints",
	"- What to avoid, and what to do when the note does not say.",
	"",
	"# Output",
	"The sections, length and format of the answer.",
	"",
	"# Stop rules",
	"When to answer, when to ask one short question, and when to say the note is not enough."
].join("\n");

function templateFrom(definition: SkillDefinition): SkillTemplate {
	return {
		id: definition.name,
		title: definition.title,
		summary: definition.description,
		path: `${definition.name}/SKILL.md`,
		content: renderSkillMarkdown(definition)
	};
}

/** Examples the user can install. They arrive unreviewed like any other vault skill. */
export const EXAMPLE_SKILL_TEMPLATES: readonly SkillTemplate[] = EXAMPLES.map(templateFrom);

/** Builds the text of a new skill from a name and description. The name is normalised to the format's rules. */
export function createSkillScaffold(name: string, description: string): SkillTemplate {
	const slug = slugifySkillName(name).slice(0, MAX_SKILL_NAME) || "my-skill";
	const text = description.trim() || "Describe what the skill does and when to use it.";
	return templateFrom({
		name: slug,
		title: name.trim() || slug,
		description: text,
		triggers: [],
		version: "1.0.0",
		body: BLANK_BODY
	});
}
