// Prompt rules shared by the built-in workflows and the translate prompt built in settings.
// This is a leaf module with no imports, so both sides can use it without an import cycle and the rules cannot drift apart.

// Workflow prompts are in English, so without this the model tends to answer in English even for notes in other languages.
export const NOTE_LANGUAGE_RULE = "Write in the main language of the note context and follow its spelling conventions, unless the user asks for another language.";

export const NO_CODE_FENCE_RULE = "Do not wrap it in a code fence.";

// Applied output becomes permanent note text, so any remark or citation would end up inside the user's note.
export const NOTE_EDIT_OUTPUT_RULE = `Return only the complete revised text, ready to replace the original. No preamble, explanation, editor notes, remarks about limitations, closing remarks, or source IDs such as [S1]. ${NO_CODE_FENCE_RULE}`;

// An unescaped pipe or a line break splits a Markdown table row, including the alias pipe inside a wikilink.
// The example is in inline code so a prompt that must not model bare wikilinks can still carry the rule.
export const TABLE_CELL_RULE = "Keep each table cell on one line: write a pipe inside a cell as \\| (including the alias pipe in a wikilink, as in `[[Note\\|alias]]`) and use <br> for a line break.";

export interface PreservedSyntaxOptions {
	/** How wikilinks and embeds are described. Translation fixes targets only, because labels may be translated. */
	wikilinks?: string;
	/** How callouts are described. */
	callouts?: string;
	/** Further items that stay identical for one workflow only. */
	extras?: readonly string[];
}

const DEFAULT_WIKILINKS = "wikilinks and embeds ([[target|alias]], ![[target]])";
const DEFAULT_CALLOUTS = "callout markers (> [!type])";

/** The Obsidian syntax that a note-edit workflow must hand back untouched. One builder serves rewrite and translate. */
export function buildPreservedSyntaxRule(options: PreservedSyntaxOptions = {}): string {
	const items = [
		"YAML frontmatter",
		"code blocks and inline code",
		"math ($...$ and $$...$$)",
		"Obsidian comments (%%...%%)",
		options.wikilinks ?? DEFAULT_WIKILINKS,
		"Markdown link and image URLs",
		"block IDs (^id)",
		"footnote labels ([^label])",
		"tags (#tag)",
		options.callouts ?? DEFAULT_CALLOUTS,
		"inline fields (key:: value)",
		"HTML tags",
		...(options.extras ?? [])
	];
	return `These stay byte-for-byte identical: ${items.join("; ")}.`;
}

export const OBSIDIAN_SYNTAX_RULE = buildPreservedSyntaxRule();

export const TRANSLATE_SYNTAX_RULE = buildPreservedSyntaxRule({
	wikilinks: "wikilink and embed targets ([[target]], ![[target]])",
	callouts: "callout type keywords (> [!note])",
	extras: ["file paths, commands and IDs"]
});
