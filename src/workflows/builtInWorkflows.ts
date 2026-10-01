import { buildTranslatePreservePrompt } from "../settings/normalize";
import type { Workflow, WorkflowOutputKind } from "../shared/types";

// Required here so the compiler rejects a built-in that forgets to say whether its output replaces the note.
export type BuiltInWorkflow = Workflow & { outputKind: WorkflowOutputKind };

interface WorkflowPromptSections {
	goal: string;
	successCriteria: string[];
	constraints: string[];
	output: string;
	stopRules: string;
}

// Workflow prompts are in English, so without this the model tends to answer in English even for notes in other languages.
export const NOTE_LANGUAGE_RULE = "Write in the main language of the note context and follow its spelling conventions, unless the user asks for another language.";

export const OBSIDIAN_SYNTAX_RULE = "These stay byte-for-byte identical: YAML frontmatter; code blocks and inline code; math ($...$ and $$...$$); Obsidian comments (%%...%%); wikilinks and embeds ([[target|alias]], ![[target]]); Markdown link and image URLs; block IDs (^id); footnote labels ([^label]); tags (#tag); callout markers (> [!type]); inline fields (key:: value); HTML tags.";

// Applied output becomes permanent note text, so any remark or citation would end up inside the user's note.
export const NOTE_EDIT_OUTPUT_RULE = "Return only the complete revised text, ready to replace the original. No preamble, explanation, editor notes, remarks about limitations, closing remarks, or source IDs such as [S1]. Do not wrap it in a code fence.";

function composeWorkflowPrompt(sections: WorkflowPromptSections): string {
	return [
		`Goal: ${sections.goal}`,
		"",
		"Success criteria:",
		...sections.successCriteria.map((line) => `- ${line}`),
		"",
		"Constraints:",
		...sections.constraints.map((line) => `- ${line}`),
		"",
		`Output: ${sections.output}`,
		"",
		`Stop rules: ${sections.stopRules}`
	].join("\n");
}

export const WORKFLOWS: BuiltInWorkflow[] = [
	{
		id: "study-summary",
		commandId: "workflow-study-summary",
		name: "Study Summary",
		shortName: "Summarise",
		description: "Study guide",
		icon: "book-open",
		accent: "blue",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "A study summary of the note context that the user can revise from.",
			successCriteria: [
				"Opens with the main idea in one or two sentences.",
				"Groups the important points by topic or sequence, keeping key terms, numbers and examples from the note.",
				"Ends with the takeaways worth remembering."
			],
			constraints: [
				"Include quotes or timestamps only when the note contains them.",
				NOTE_LANGUAGE_RULE
			],
			output: "Concise Obsidian Markdown: a short summary paragraph, topic headings with bullets, then a Key takeaways list.",
			stopRules: "Stop after Key takeaways. If the note has too little content for a study summary, say so in one sentence and stop."
		})
	},
	{
		id: "action-plan",
		commandId: "workflow-action-plan",
		name: "Action Plan",
		shortName: "Plan",
		description: "Next steps",
		icon: "list-checks",
		accent: "green",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "A practical action plan that moves the user towards the outcome the note context points to.",
			successCriteria: [
				"States the intended outcome.",
				"Lists concrete next actions in priority order, with owners, deadlines, tools, costs or dependencies only where the note gives them.",
				"Names the decisions needed, risks, blockers and open questions.",
				"Ends with the single first step to take."
			],
			constraints: [
				"Label any assumption as an assumption. Leave missing owners and dates unstated rather than guessing.",
				NOTE_LANGUAGE_RULE
			],
			output: "Obsidian Markdown with the sections Outcome, Next actions (numbered), Decisions needed, Risks and blockers, Open questions, and First step. Omit a section the note gives nothing for.",
			stopRules: "Stop after First step. If the note points to no outcome or action, say so in one sentence and stop."
		})
	},
	{
		id: "explain-simply",
		commandId: "workflow-explain-simply",
		name: "Explain Simply",
		shortName: "Explain",
		description: "Plain language",
		icon: "sparkles",
		accent: "violet",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "A plain-language explanation of the note context that keeps its important meaning.",
			successCriteria: [
				"Opens with the core idea in one or two plain sentences.",
				"Defines jargon and complex ideas in simple words.",
				"Uses at most one short example or analogy, only when it helps and fits the note.",
				"Keeps what the note says separate from anything uncertain or missing."
			],
			constraints: [
				"Do not add outside facts unless the user asks for them.",
				NOTE_LANGUAGE_RULE
			],
			output: "Short headings and bullets, ending with a Remember this section of two to four bullets.",
			stopRules: "Stop after Remember this."
		})
	},
	{
		id: "question-drill",
		commandId: "workflow-question-drill",
		name: "Question Drill",
		shortName: "Drill",
		description: "Practice Qs",
		icon: "circle-help",
		accent: "amber",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "An active-recall drill that tests the important ideas in the note context.",
			successCriteria: [
				"Questions test understanding of important ideas, not trivia.",
				"Each answer is concise and supported by the note.",
				"A few harder synthesis questions are included when the note supports them.",
				"Areas where the note lacks enough detail for a fair question are flagged."
			],
			constraints: [
				"Do not ask questions whose answers the note does not contain.",
				NOTE_LANGUAGE_RULE
			],
			output: "An Obsidian Markdown table with the columns Question, Answer and Why it matters, ordered from basic to harder, followed by a Gaps line naming thin areas (omit it when there are none).",
			stopRules: "Stop after the table and Gaps line. If the note is too thin for a fair drill, say what is missing in one or two sentences and stop."
		})
	},
	{
		id: "buyer-protection-analysis",
		commandId: "workflow-buyer-protection-analysis",
		name: "Buyer Protection Analysis",
		shortName: "Protect",
		description: "Spot hype",
		icon: "shield-alert",
		accent: "rose",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "A verdict on whether the note, transcript or sales-style content gives practical value or mainly creates desire, fear, curiosity or pressure to buy, follow, join or pay.",
			successCriteria: [
				"Gives a direct verdict and a buyer caution level: Low, Medium, High or Very High.",
				"Separates useful takeaways from vague motivation and unsupported claims.",
				"Names persuasion tactics, red flags and missing proof, each tied to what the content says.",
				"Ends with the safest practical next step for the user."
			],
			constraints: [
				"Be fair, sceptical and specific. Treat income claims, case studies, screenshots, shortcuts and success stories as unverified unless the content proves them.",
				NOTE_LANGUAGE_RULE
			],
			output: "Obsidian Markdown with the sections Direct verdict, Useful takeaways, Persuasion tactics, Red flags, Missing evidence, and What to do next.",
			stopRules: "Stop after What to do next. If the content is not trying to sell or persuade, say so in the verdict and keep the other sections brief."
		})
	},
	{
		id: "knowledge-graph-links",
		commandId: "workflow-knowledge-graph-links",
		name: "Knowledge Graph Links",
		shortName: "Links",
		description: "Suggest [[links]]",
		icon: "network",
		accent: "violet",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "Suggested Obsidian wikilinks that would connect this note to useful notes in the user's knowledge graph.",
			successCriteria: [
				"Gives 8 to 15 high-signal suggestions (fewer when the note is thin), favouring named people, organisations, tools, frameworks, methods, problems and recurring concepts.",
				"Each suggestion uses a clean note-style name and says briefly why it matters and where it fits.",
				"Reuses names already linked or used in the note exactly as written, in the note's language and spelling.",
				"Avoids vague names such as Thing, People, Video, Success, Business or Money unless the note gives a precise reason."
			],
			constraints: [
				"Suggestions stay inert until the user accepts them, so saving or applying this reply must not create graph links. Outside the copy-ready code block, write every suggested link as inline code, such as `[[Customer Acquisition]]`, never as a bare wikilink.",
				"Name cautioned or rejected links as inline code without brackets, such as `Business`.",
				"You cannot see the user's other notes, so do not claim that a note exists.",
				NOTE_LANGUAGE_RULE
			],
			output: [
				"Obsidian Markdown with these sections:",
				"### Suggested links: a table with the columns Link, Why it matters and Where to use it.",
				"### Copy-ready links: one fenced code block with the language text, holding the best links one per line as [[Name]].",
				"### Inline linking: 3 to 6 bullets, each pairing an exact phrase from the note with its link, using an alias such as `[[Customer Acquisition|finding customers]]` only when the phrase differs from the note name.",
				"### Link hygiene: brief cautions about links that are too broad, duplicated or not worth creating."
			].join("\n"),
			stopRules: "Stop after Link hygiene. If the note is too thin for useful links, say so and suggest at most three."
		})
	},

	{
		id: "mermaid-diagram",
		commandId: "workflow-mermaid-diagram",
		name: "Mermaid Diagram",
		shortName: "Diagram",
		description: "Visual map",
		icon: "workflow",
		accent: "blue",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "One valid Mermaid diagram that visualises the note context and renders in Obsidian without cleanup.",
			successCriteria: [
				"Uses the diagram type that best fits, such as flowchart, mindmap, sequenceDiagram, timeline, journey or classDiagram.",
				"Shows the main entities, steps, decisions, relationships, causes or timeline, with short labels traceable to the note.",
				"Shows a gap as a labelled node only when the note itself points to it."
			],
			constraints: [
				"Do not add relationships the note does not state or clearly imply.",
				"Prefer a simple diagram over a crowded one.",
				"Quote or simplify labels that could break Mermaid syntax, including quotes, pipes, brackets, and Markdown or wiki links.",
				NOTE_LANGUAGE_RULE
			],
			output: "One fenced code block with the language mermaid. Add one short sentence after it only if the note is too thin or an assumption was necessary.",
			stopRules: "Stop after the Mermaid block and that optional sentence. Do not offer alternative diagrams or explain the process."
		})
	},
	{
		id: "key-insights",
		commandId: "workflow-key-insights",
		name: "Key Insights",
		shortName: "Insights",
		description: "Best ideas",
		icon: "lightbulb",
		accent: "amber",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "The most useful insights in the note context, each traceable to the note.",
			successCriteria: [
				"Picks the strongest ideas, patterns, claims and implications, usually three to seven, and leaves out points that are merely obvious.",
				"Pairs each insight with the note detail or short quote that supports it.",
				"Labels any insight that rests on thin or unclear evidence."
			],
			constraints: [
				"Quote only wording that appears in the note.",
				NOTE_LANGUAGE_RULE
			],
			output: "A numbered list. Each item has the insight in bold, then an Evidence line and a Why it matters line.",
			stopRules: "Stop after the last insight. If the note has no insight beyond its surface content, say so in one sentence and stop."
		})
	},
	{
		id: "critical-review",
		commandId: "workflow-critical-review",
		name: "Critical Review",
		shortName: "Critique",
		description: "Find gaps",
		icon: "search",
		accent: "rose",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "A fair critical review of the note context that exposes weak reasoning, missing evidence and unclear claims.",
			successCriteria: [
				"Lists the main claims being made.",
				"Points out unsupported claims, vague language, contradictions and hidden assumptions, each tied to the passage concerned.",
				"Separates serious problems from minor improvements.",
				"Suggests practical fixes or questions to answer next."
			],
			constraints: [
				"Be fair and specific: credit what is well supported, and label uncertainty.",
				NOTE_LANGUAGE_RULE
			],
			output: "Sections: Main claims, Strong points, Serious issues, Minor issues, Missing evidence, and Fix next.",
			stopRules: "Stop after Fix next. If the note makes no claims worth reviewing, say so in one sentence and stop."
		})
	},
	{
		id: "pros-cons",
		commandId: "workflow-pros-cons",
		name: "Pros And Cons",
		shortName: "Pros/Cons",
		description: "Weigh it up",
		icon: "scale",
		accent: "slate",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "A balanced pros and cons analysis of the decision, idea, offer or position in the note context.",
			successCriteria: [
				"States what is being evaluated.",
				"Lists the strongest pros and cons the note supports, plus the risks, trade-offs and unknowns that matter.",
				"Says when the note is one-sided.",
				"Recommends only if the evidence supports a recommendation."
			],
			constraints: [
				"Label any inferred point as inferred.",
				NOTE_LANGUAGE_RULE
			],
			output: "One line stating what is evaluated, an Obsidian Markdown table with the columns Pros and Cons, a short Risks and unknowns list, then either a short Recommendation or one line saying why the evidence does not support one.",
			stopRules: "Stop after the Recommendation line."
		})
	},
	{
		id: "flashcards",
		commandId: "workflow-flashcards",
		name: "Flashcards",
		shortName: "Cards",
		description: "Study cards",
		icon: "copy-check",
		accent: "blue",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "Flashcards for the key concepts, facts, definitions, decisions and examples in the note context.",
			successCriteria: [
				"Each card tests one idea, and its answer is short enough to memorise.",
				"No trivial or duplicate cards.",
				"Each Source clue points to where the answer comes from, such as a heading or short phrase from the note."
			],
			constraints: [
				"Do not write cards whose answers the note does not contain.",
				NOTE_LANGUAGE_RULE
			],
			output: "An Obsidian Markdown table with the columns Front, Back and Source clue.",
			stopRules: "Stop after the table. If the note is too thin for useful cards, say so in one sentence and stop."
		})
	},
	{
		id: "meeting-notes",
		commandId: "workflow-meeting-notes",
		name: "Meeting Notes",
		shortName: "Meeting",
		description: "Clean notes",
		icon: "messages-square",
		accent: "green",
		// Restructuring a raw transcript drops detail, so the cleaned notes are added alongside the source rather than replacing it.
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "Clean, scannable meeting notes from the rough meeting notes, call notes or transcript snippets in the note context.",
			successCriteria: [
				"Captures decisions, action items, owners, deadlines, blockers and open questions when present.",
				"Keeps discussion points concise and grouped by topic.",
				"Preserves names, dates, numbers and commitments exactly.",
				"Marks a missing owner or deadline as not stated."
			],
			constraints: [
				"Do not invent attendees, commitments or decisions. Include quotes or timestamps only when the source has them.",
				NOTE_LANGUAGE_RULE
			],
			output: "Sections: Summary, Decisions, Actions (with owner and deadline where known), Discussion, Risks, and Open questions. Omit a section the source gives nothing for.",
			stopRules: "Stop after the last section. If the context contains no meeting or call content, say so in one sentence and stop."
		})
	},
	{
		id: "research-map",
		commandId: "workflow-research-map",
		name: "Research Map",
		shortName: "Research",
		description: "Explore next",
		icon: "compass",
		accent: "violet",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "A research map, built from the note context, that shows the user what to investigate next.",
			successCriteria: [
				"Identifies the central topic and its subtopics.",
				"Lists the most important unanswered questions.",
				"Suggests search terms, source types and the evidence to look for.",
				"Puts the highest-leverage next steps first."
			],
			constraints: [
				"This is a plan from the current note: do not present outside knowledge as findings or claim to have researched anything.",
				NOTE_LANGUAGE_RULE
			],
			output: "Sections: Topic map (nested bullets), Open questions, Evidence needed, and Next searches (in priority order, with suggested search terms).",
			stopRules: "Stop after Next searches."
		})
	},
	{
		id: "decision-brief",
		commandId: "workflow-decision-brief",
		name: "Decision Brief",
		shortName: "Decision",
		description: "Choose well",
		icon: "file-question",
		accent: "amber",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "A decision brief that helps the user make the decision in the note context, or shows what is still needed to make it.",
			successCriteria: [
				"States the decision to be made.",
				"Summarises the evidence, options, trade-offs and risks from the note.",
				"Names the information still missing before deciding.",
				"Recommends the next best decision step, and a final choice only if the evidence supports one."
			],
			constraints: [
				"Label any assumption as an assumption.",
				NOTE_LANGUAGE_RULE
			],
			output: "Sections: Decision, Evidence, Options (with trade-offs), Risks, Missing information, and Next step.",
			stopRules: "Stop after Next step. If the note contains no decision, say so in one sentence and stop."
		})
	},
	{
		id: "compare-ideas",
		commandId: "workflow-compare-ideas",
		name: "Compare Ideas",
		shortName: "Compare",
		description: "Contrast ideas",
		icon: "git-compare",
		accent: "blue",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "A comparison of the main ideas, options, people, tools, methods or arguments in the note context.",
			successCriteria: [
				"States what is being compared.",
				"Covers similarities, differences, strengths, weaknesses and best use cases, using details from the note.",
				"Says where the note lacks the information for a fair comparison."
			],
			constraints: [
				"Do not add outside facts unless the user asks for them.",
				NOTE_LANGUAGE_RULE
			],
			output: "One line stating what is compared, a Markdown comparison table (one column per item, one row per criterion), then a short Takeaway.",
			stopRules: "Stop after the Takeaway. If the note has fewer than two things to compare, say so in one sentence and stop."
		})
	},
	{
		id: "translate-preserve",
		commandId: "workflow-translate-preserve",
		name: "Translate Preserve",
		shortName: "Translate",
		description: "Keep meaning",
		icon: "languages",
		accent: "green",
		outputKind: "note-edit",
		prompt: (settings) => buildTranslatePreservePrompt(settings.translationTargetLanguage)
	},
	{
		id: "quote-extractor",
		commandId: "workflow-quote-extractor",
		name: "Quote Extractor",
		shortName: "Quotes",
		description: "Pull quotes",
		icon: "quote",
		accent: "rose",
		outputKind: "new-content",
		prompt: composeWorkflowPrompt({
			goal: "The strongest quotes, claims, examples, numbers and memorable lines from the note context, ready to reference later.",
			successCriteria: [
				"Selects only specific, useful lines and avoids over-quoting weak ones.",
				"Keeps quoted wording exact, and labels anything not verbatim as a paraphrase.",
				"Says briefly why each item matters.",
				"Lists unsupported or questionable claims separately."
			],
			constraints: [
				"Never invent or reconstruct a quote.",
				NOTE_LANGUAGE_RULE
			],
			output: "Sections: Best quotes, Key claims, Useful examples, Numbers, and Cautions. Omit a section the note gives nothing for.",
			stopRules: "Stop after the last section. If the note has nothing worth quoting, say so in one sentence and stop."
		})
	},

	{
		id: "rewrite-polish",
		commandId: "workflow-rewrite-polish",
		name: "Rewrite Polish",
		shortName: "Polish",
		description: "Clean rewrite",
		icon: "wand-2",
		accent: "slate",
		outputKind: "note-edit",
		prompt: composeWorkflowPrompt({
			goal: "A clearer, more polished version of the note context that can replace the original text directly without breaking any Obsidian Markdown.",
			successCriteria: [
				"Meaning, facts, names, numbers, dates, caveats and uncertainty are unchanged.",
				"Wording, flow and readability are improved, and repetition is removed without losing information.",
				"The existing structure stays: heading levels, lists, tables and section order. Do not add headings, sections or summaries the original does not have.",
				OBSIDIAN_SYNTAX_RULE
			],
			constraints: [
				"Do not add facts, examples, opinions or conclusions. If the source is fragmented, tidy the wording without filling the gaps.",
				"Keep the note's language and spelling conventions."
			],
			output: NOTE_EDIT_OUTPUT_RULE,
			stopRules: "Stop after the last line of the revised text. If there is no text to revise, reply with one short sentence saying so and nothing else."
		})
	}
];
