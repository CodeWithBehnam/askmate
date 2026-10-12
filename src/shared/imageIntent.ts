// Image generation costs money and needs an OpenAI key, so detection is deliberately strict:
// only an explicit command or an imperative request at the very start of the question counts.
// Definite objects ("make the image smaller", "draw the line") usually refer to existing content, so
// only indefinite objects ("a", "an", "some", a number) count as a request for a new image.
//
// Diagram wording ("draw a state machine", "draw a roadmap") is Mermaid work, never image work. detectDiagramIntent
// is evaluated first, and the draw rule also blocks structural subjects on its own. A wrongly blocked picture costs the user
// one retry with /image or the word "picture"; a wrongly allowed one costs money and returns a PNG with garbled labels.
//
// Explicit picture wording outranks that block: "draw a picture of a roadmap", "draw a roadmap as an image" and
// "draw a roadmap poster" are image requests. Both routes share one predicate for that wording (asksForRasterPicture), so a draw
// request reaches the diagram path or the image path and is never dropped between them.
//
// The predicate only counts an image word that names the medium of the output, never one that is the topic of the diagram
// ("draw a flowchart for uploading a photo", "draw a diagram of the big picture"), and a negation earlier in the same sentence
// ("not as an image", "I don't want a picture", "in mermaid") vetoes it. A verb clause in front of "as an image" or "in png format"
// vetoes it as well: "of the app saving a note as an image" is about the app, not about the output. Every rule leans towards text,
// the cheap side to be wrong on.
//
// The create verbs ("create a logo") only honour a negation right in front of the image noun ("create a roadmap without an image").
// Words that describe the picture ("no smoking poster", "text only logo") are part of the request.

const POLITE_PREFIX = "(?:(?:please|pls)[,!]?\\s+)?(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?";
const RECIPIENT = "(?:(?:me|us)\\s+)?";
const INDEFINITE_DETERMINER = "(?:(?:a|an|one|some|two|three|four|five|\\d+|another)\\s+)?";
const DEFINITE_WORDS = "the|this|that|these|those|my|our|your|its|their|his|her";
const IMAGE_NOUN = "(?:images?|pictures?|pics?|photos?|photographs?|illustrations?|artworks?|drawings?|paintings?|sketch(?:es)?|wallpapers?|posters?|banners?|logos?|icons?|thumbnails?|portraits?)";
// Words that end a descriptive phrase, so "make a list of the photo section" never reaches the image noun.
const FILLER_WORD = `(?!(?:of|for|about|in|on|with|to|from|which|by|as|at|into|than|sure|${DEFINITE_WORDS})\\b)[a-z0-9'-]+\\s+`;
// The image noun must end the request or be followed by a word that describes the picture. A noun used as a modifier
// ("logo ideas", "poster outline", "photo checklist", "image prompt") names text work, so it is not an image request.
const NOUN_FOLLOW = "(?=$|[,.:;!?)]|\\s+(?:of|for|showing|depicting|illustrating|featuring|with|that|which|where|in|on|about|like|using|based|and)\\b)";

const CREATE_VERB = "(?:create|generate|make|render|produce|design|illustrate)";
const CREATE_REQUEST = new RegExp(
	`^${POLITE_PREFIX}${CREATE_VERB}\\s+(?!sure\\b)${RECIPIENT}${INDEFINITE_DETERMINER}(?:${FILLER_WORD}){0,3}${IMAGE_NOUN}${NOUN_FOLLOW}`
);

// ---------------------------------------------------------------------------
// Diagram vocabulary
// ---------------------------------------------------------------------------

// Nouns that name a diagram on their own, so any imperative request for one is diagram work.
const STRONG_DIAGRAM_NOUN =
	"(?:diagrams?|flow ?charts?|mind ?maps?|org(?:ani[sz]ation(?:al)?)? charts?|gantts?|kanbans?|swim ?lanes?|(?:finite[- ])?state[- ]?machines?|fsms?|state ?charts?|charts?|graphs?|sankeys?|venn)";
// Nouns that name a diagram only next to a draw-like verb and near the start of the object ("draw a roadmap").
// Bare "model", "tree" and "map" are left out here because "draw a 3D model" or "draw a tree" can be a real picture;
// the compound forms below ("decision tree", "concept map", "ER model") are unambiguous.
const WEAK_DIAGRAM_NOUN =
	"(?:timelines?|road ?maps?|architectures?|work ?flows?|flows?|journeys?|topolog(?:y|ies)|hierarch(?:y|ies)|schemas?|schemata|pipelines?|life ?cycles?|er models?|(?:data|domain|class|object|entity[- ]relationship) models?|(?:concept|process|site|journey|story|dependency|knowledge|value[- ]stream) maps?|(?:decision|dependency|family|file|folder|component|org) trees?)";
// Subjects that are text work for the paid image path even though they are not diagrams: tables, and the bare structural nouns.
const OTHER_TEXT_NOUN = "(?:tables?|maps?|trees?|structures?|overviews?)";
const ANY_STRUCTURE_NOUN = `(?:${STRONG_DIAGRAM_NOUN}|${WEAK_DIAGRAM_NOUN}|${OTHER_TEXT_NOUN})`;

// Wording that asks for a raster picture. It outranks diagram nouns: "draw a picture of a roadmap" is an image request.
const IMAGE_MEDIUM_WORD = "(?:images?|pictures?|pics?|photos?|photographs?|illustrations?|artworks?|paintings?|wallpapers?|posters?|png|jpe?g)";
const IMAGE_FORMAT_WORD = "(?:png|jpe?g)";
// The medium word ends the phrase or is followed by a word that describes the picture. "image processing" and "photo app" are topics.
const IMAGE_MEDIUM_FOLLOW =
	"(?=$|[,.:;!?)]|\\s+(?:of|for|showing|depicting|illustrating|featuring|with|that|which|where|in|on|about|like|using|based|and|or|please|pls|thanks|format|files?)\\b)";
// Words that may sit between a medium preposition and the medium word ("as a high resolution png"). Determiners, prepositions and
// negations end the run, so "as the image shows" and "as seen in the picture" are not a medium. A structural noun ends it too:
// "draw a roadmap showing photos" is a roadmap about photos, not a picture.
const NON_MODIFIER = `(?:${DEFINITE_WORDS}|a|an|of|for|about|in|on|with|to|from|which|by|as|at|into|than|and|or|that|where|not|no|never|without|but)(?![\\w-])`;
const mediumModifiers = (max: number): string => `(?:(?!${NON_MODIFIER}|${ANY_STRUCTURE_NOUN}\\b)[a-z0-9'-]+\\s+){0,${max}}`;

// An image word only names the medium in one of these positions. Anywhere else ("of the big picture", "for uploading a photo",
// "to a photo", "the people in a photo") it names what the diagram is about, so the request stays on the diagram path.
const MEDIUM_POSITIONS: readonly RegExp[] = [
	// The head of the object: "draw a picture of a roadmap", "draw me a pretty photo of the plan".
	`^${POLITE_PREFIX}[a-z]+(?:\\s+(?:out|up))?\\s+${RECIPIENT}${INDEFINITE_DETERMINER}${mediumModifiers(2)}${IMAGE_MEDIUM_WORD}${IMAGE_MEDIUM_FOLLOW}`,
	// "as an image", "as a high resolution png".
	`\\bas\\s+(?:an?\\s+)?${mediumModifiers(3)}${IMAGE_MEDIUM_WORD}${IMAGE_MEDIUM_FOLLOW}`,
	// "in png format". A bare "in a photo" is a topic ("the people in a photo"), so only file formats count after "in".
	`\\bin\\s+(?:an?\\s+)?${mediumModifiers(3)}${IMAGE_FORMAT_WORD}${IMAGE_MEDIUM_FOLLOW}`,
	// Right behind the structure: "state machine image", "roadmap poster", "kanban board image", "roadmap in a picture". The first
	// group is the structure itself, which belongs to the text in front of the medium ("create a state machine" before "image").
	`\\b(${ANY_STRUCTURE_NOUN})(?:\\s+boards?)?\\s+(?:in\\s+(?:an?\\s+)?${mediumModifiers(3)})?${IMAGE_MEDIUM_WORD}${IMAGE_MEDIUM_FOLLOW}`
].map((pattern) => new RegExp(pattern, "g"));

// Cues that the user wants text, does not want a picture, or has opened a subordinate clause. Any of them earlier in the same sentence
// as the medium word vetoes it: "not as an image", "I don't want it as a picture", "in mermaid, as a png", "of how it saves a note as
// an image". The look-back is bounded so hostile input stays linear.
// Hyphens count as part of a word, so "how-to poster" and "no-background logo" do not trip it.
const VETO_WORDS =
	"no|not|never|without|avoid|skip|instead|rather|nor|cannot|dont|text[- ]only|only text|plain[- ]text|as text|in text|text please|mermaid|how|what|when|where|why|whether|which|who|that";
const PICTURE_VETO_CUE = new RegExp(`(?<![\\w-])(?:${VETO_WORDS})(?![\\w-])|n['\\u2019]t(?![\\w-])`);
const SENTENCE_BOUNDARY = /[.?!;]/;
const VETO_LOOKBACK = 240;

// ---------------------------------------------------------------------------
// Topic clauses
// ---------------------------------------------------------------------------

// "as an image" and "in png format" name the output of "draw a roadmap as a png", but behind a clause with a verb of its own they
// belong to that verb: "of the app saving a note as an image", "for uploading a file in png format", "to export the note as a png".
// The check works on the last clause in front of the medium word and does not depend on the veto cues above.
const TOPIC_OPENERS: ReadonlySet<string> = new Set(
	"of for about showing depicting illustrating describing explaining covering on with from by between via through to where when while after before during once if that which whose".split(" ")
);
const CLAUSE_BREAKS: ReadonlySet<string> = new Set([",", ":", "and", "but", "then", "please", "pls"]);
const DETERMINERS: ReadonlySet<string> = new Set([...DEFINITE_WORDS.split("|"), "a", "an", "some", "any", "each", "every", "all", "another", "one"]);
const PRONOUN_OBJECTS: ReadonlySet<string> = new Set(["it", "this", "that", "them", "these", "those"]);
// Verbs that move a file or an image somewhere, as base forms, participles and gerunds. Next to a topic opener they mark the topic
// ("note export", "a photo upload feature", "notes saved").
const EXPORT_VERB =
	/^(?:export(?:s|ed|ing)?|sav(?:e|es|ed|ing)|stor(?:e|es|ed|ing)|convert(?:s|ed|ing)?|render(?:s|ed|ing)?|publish(?:es|ed|ing)?|shar(?:e|es|ed|ing)|upload(?:s|ed|ing)?|download(?:s|ed|ing)?|embed(?:s|ded|ding)?|attach(?:es|ed|ing)?|send(?:s|ing)?|sent|return(?:s|ed|ing)?|output(?:s|ted|ting)?|shown|formatted|encoded|delivered|transformed)$/;
// Base forms of the export verbs read as nouns as often as verbs ("a render pipeline", "the upload page").
const EXPORT_BASE = /^(?:export|save|store|convert|render|publish|share|upload|download|embed|attach|send|return|output)$/;
// Other verbs that act on a note or an image. Only the forms that cannot be nouns count on their own: "open" and "post" are common words,
// "opens" after a subject and "opened" after a topic opener are not.
const CONTENT_BASE = /^(?:open|view|edit|resize|crop|import|delete|rename|sync|scan|load|submit|post|paste|copy|print|insert|write|read|create|generate|produce|display|capture)$/;
const CONTENT_S = /^(?:opens|views|edits|resizes|crops|imports|deletes|renames|syncs|scans|loads|submits|posts|pastes|copies|prints|inserts|writes|reads|creates|generates|produces|displays|captures)$/;
const CONTENT_ED =
	/^(?:opened|viewed|edited|resized|cropped|imported|deleted|renamed|synced|scanned|loaded|submitted|posted|pasted|copied|printed|inserted|written|created|generated|produced|displayed|captured)$/;
// Verbs that describe what the diagram contains or is for. "a roadmap showing milestones as a png" is still about the medium.
const PURPOSE_VERB =
	/^(?:show|depict|illustrat|describ|explain|cover|visuali[sz]|summari[sz]|represent|outlin|clarif|communicat|understand|explor|compar|help|plan|featur|includ|contain|hav|us|follow|highlight|label|group|link|connect|map|track|document|contrast|list|present)(?:e|es|ed|d|s|ing|ning|ping|ling|ies|y)?$|^see(?:s|ing)?$/;
const GERUND = /^[a-z]{2,}ing$/;
const NON_GERUND: ReadonlySet<string> = new Set(["bring", "thing", "string", "spring", "sting", "swing", "during", "evening", "morning", "ceiling", "something", "anything", "everything", "nothing"]);
// Gerunds that mostly name a thing or a department ("the billing service", "a data processing pipeline") and act as a verb only with a
// determiner after them ("booking a flight") or straight behind a topic opener ("for billing customers").
const NOUN_GERUNDS: ReadonlySet<string> = new Set(
	"billing pricing booking shipping onboarding offboarding training testing marketing accounting banking networking engineering hiring recruiting staffing advertising routing hosting monitoring building planning funding ticketing voting parking housing shopping trading messaging scheduling reporting ordering caching tracking streaming ranking rating matching sorting filtering indexing versioning processing".split(" ")
);
// What a clause-initial delivery verb may act on without making the clause a topic: "and render the diagram as an image".
const DIAGRAM_OBJECT = new RegExp(
	`^(?:(?!(?:of|for|about|in|on|with|to|from|which|by|as|at|into|than)\\b)[a-z0-9'-]+ ){0,3}(?:${ANY_STRUCTURE_NOUN}|results?|outputs?|drawings?|visuals?|graphics?)\\b`
);
const MODALS: ReadonlySet<string> = new Set(["can", "could", "should", "would", "will", "must", "may", "might", "shall"]);
// "logging in" and "signing up" are complete without an object.
const PARTICLES: ReadonlySet<string> = new Set(["in", "out", "up", "down", "off", "on", "back", "over", "away"]);

const isGerund = (word: string): boolean => GERUND.test(word) && !NON_GERUND.has(word);
// The word that starts the object of the verb at i, or undefined when the verb ends the clause.
const objectOf = (clause: readonly string[], i: number): string | undefined => clause[i + (PARTICLES.has(clause[i + 1] ?? "") ? 2 : 1)];
const actsOnDiagram = (clause: readonly string[], i: number): boolean => {
	const object = objectOf(clause, i);
	return object === undefined || PRONOUN_OBJECTS.has(object) || (DETERMINERS.has(object) && DIAGRAM_OBJECT.test(clause.slice(i + 2).join(" ")));
};

// "saving a note", "uploading files": a gerund with an object of its own. Without one it is a noun ("for onboarding"), unless it is an
// export verb ("for exporting").
function isGerundTopic(word: string, object: string | undefined, prev: string, i: number, afterOpener: boolean): boolean {
	const exportVerb = EXPORT_VERB.test(word);
	if (object === undefined) return exportVerb && afterOpener;
	if (PRONOUN_OBJECTS.has(object)) return afterOpener;
	// "a data processing pipeline": a thing-like gerund inside a noun phrase is a noun when a plain noun follows it.
	const thingLike = NOUN_GERUNDS.has(word) && i > 0 && !TOPIC_OPENERS.has(prev) && !exportVerb;
	return !(thingLike && !DETERMINERS.has(object) && object !== "of");
}

// "for note export", "the user saves notes", "users can save a note", "a note saved": a base form behind an opener or a modal, or a
// conjugated verb with an object of its own.
function isFiniteTopic(word: string, object: string | undefined, prev: string, i: number, afterOpener: boolean): boolean {
	if (EXPORT_BASE.test(word)) return afterOpener || i === 0 || MODALS.has(prev);
	if (CONTENT_BASE.test(word)) return i === 0 || MODALS.has(prev);
	const hasSubjectObject = object !== undefined && (EXPORT_VERB.test(word) || DETERMINERS.has(object) || PRONOUN_OBJECTS.has(object));
	return i === 0 || hasSubjectObject || (afterOpener && !CONTENT_S.test(word));
}

// A verb that opens the clause and acts on the diagram itself ("and render it as a png", "and save as png", "and export the chart as
// an image") says how to deliver the output. Anywhere else, or with an object of its own ("and export the note as a png"), it is part of
// the topic.
function isTopicVerbAt(clause: readonly string[], i: number, afterOpener: boolean): boolean {
	const word = clause[i] ?? "";
	const gerund = isGerund(word);
	const exportVerb = EXPORT_VERB.test(word);
	const verb = gerund || exportVerb || CONTENT_BASE.test(word) || CONTENT_S.test(word) || CONTENT_ED.test(word);
	if (PURPOSE_VERB.test(word) || !verb) return false;
	if (i === 0 && actsOnDiagram(clause, i)) return false;
	const object = objectOf(clause, i);
	const prev = clause[i - 1] ?? "";
	// "the export screen", "our send flow", "the training pipeline": right behind a determiner and in front of a plain noun the word
	// modifies that noun. "of" or a determiner after it gives it an object ("the upload of a file"), which makes it the topic.
	const modifier = DETERMINERS.has(prev) && object !== undefined && object !== "of" && !DETERMINERS.has(object);
	if (modifier && !(gerund && exportVerb)) return false;
	return gerund ? isGerundTopic(word, object, prev, i, afterOpener) : isFiniteTopic(word, object, prev, i, afterOpener);
}

// "to export a note" and "to resize the photo" open an infinitive, "from login to checkout" and "path to production" do not.
function opensInfinitive(clause: readonly string[], i: number): boolean {
	const word = clause[i + 1] ?? "";
	const isRange = clause.slice(0, i).includes("from");
	const notVerb = word === "" || DETERMINERS.has(word) || PRONOUN_OBJECTS.has(word) || /^\d/.test(word) || PURPOSE_VERB.test(word);
	return !isRange && !notVerb && (EXPORT_VERB.test(word) || isGerund(word) || objectOf(clause, i + 1) !== undefined);
}

function lastClause(words: readonly string[]): readonly string[] {
	const lastBreak = words.reduce((found, word, i) => (CLAUSE_BREAKS.has(word) ? i : found), -1);
	return words.slice(lastBreak + 1);
}

const LEADING_POLITE_PREFIX = new RegExp(`^${POLITE_PREFIX}`);

function hasTopicVerbBefore(sentence: string): boolean {
	const request = sentence.replace(LEADING_POLITE_PREFIX, "");
	const words = request.replace(/[(){}[\]"\u201c\u201d/]/g, " ").replace(/[,:]/g, " $& ").split(" ").filter((word) => word !== "");
	const clause = lastClause(words);
	// In the first clause, word 0 is the request's own command verb ("create me a flowchart image"), never a topic verb.
	// Later clauses keep the clause-initial rule ("and export the note as a png").
	const firstWordIsCommand = clause.length === words.length;
	const opener = clause.findIndex((word) => TOPIC_OPENERS.has(word));
	return clause.some((word, i) => {
		if (i === 0 && firstWordIsCommand) return false;
		return word === "to" ? opensInfinitive(clause, i) : isTopicVerbAt(clause, i, opener !== -1 && opener < i);
	});
}

// ---------------------------------------------------------------------------
// Draw and paint
// ---------------------------------------------------------------------------

// "Draw" and "paint" are visual on their own, except in idioms and in text-diagram requests.
// The lookahead and back-reference make the recipient and determiner atomic, so the object check
// cannot be bypassed by backtracking over "a" or "me".
const DRAW_VERB = "(?:draw|paint)";
const DRAW_IDIOM_OBJECTS = "on|from|up|out|upon|in|into|attention|conclusions?|comparisons?|parallels?|distinctions?|lines?|inferences?|insights?|lessons?|connections?";
const DRAW_TEXT_OBJECTS = "diagrams?|charts?|graphs?|tables?|flowcharts?|mind|mindmaps?|timelines?|outlines?|plans?|lists?|summary|summaries|mermaid|ascii";
// Idioms and definite objects never start an image request, whatever else the question says.
const DRAW_PICTURE_OBJECT_BLOCK = `(?!(?:${DRAW_IDIOM_OBJECTS}|${DEFINITE_WORDS})\\b)`;
const DRAW_OBJECT_BLOCK = `(?!(?:${DRAW_IDIOM_OBJECTS}|${DRAW_TEXT_OBJECTS}|${DEFINITE_WORDS})\\b)`;
// Modifiers sit between the determiner and the noun ("a pie chart", "a sequence diagram of login", "a high level architecture"),
// so a structural noun within the first three words also marks the request as text work. An image noun first
// ("a picture of a roadmap") ends the search: the user asked for a picture.
const DRAW_TEXT_DIAGRAM_BLOCK = `(?!(?:(?!${IMAGE_NOUN}\\b)[a-z0-9-]+\\s+){0,2}${ANY_STRUCTURE_NOUN}\\b)`;
const drawRequest = (...blocks: readonly string[]): RegExp =>
	new RegExp(`^${POLITE_PREFIX}${DRAW_VERB}\\s+(?=(${RECIPIENT}${INDEFINITE_DETERMINER}))\\1${blocks.join("")}[a-z0-9]`);
const DRAW_REQUEST = drawRequest(DRAW_OBJECT_BLOCK, DRAW_TEXT_DIAGRAM_BLOCK);
// The same request shape without the structural-noun blocks. It only counts together with explicit picture wording, so
// "draw a roadmap as an image" and "draw a flowchart as a PNG" reach image generation while a bare "draw a roadmap" stays text.
const DRAW_PICTURE_REQUEST = drawRequest(DRAW_PICTURE_OBJECT_BLOCK);

// ---------------------------------------------------------------------------
// Diagram intent
// ---------------------------------------------------------------------------

const EXPLICIT_DIAGRAM_COMMAND = /^\/diagram\b/;
const EXPLICIT_IMAGE_COMMAND = /^\/(?:image|img)\b/;

const OBJECT_HEAD = `${RECIPIENT}(?:(?:a|an|the|this|that|these|those|my|our|your|some|one|another|\\d+)\\s+)?`;
// Verb particles and idioms that make "draw" mean something else: draw on, draw from, draw attention to, draw the line between.
const DRAW_IDIOM_BLOCK = "(?!(?:on|from|upon)\\b|(?:attention|conclusions?|comparisons?|parallels?|distinctions?|inferences?|insights?|lessons?|connections?|lines?)\\s+(?:to|from|between|about|with|on|of|for|that)\\b)";
// Up to two modifier words, none of which is a preposition or a determiner: "a high level architecture", "a user journey".
const MODIFIERS = `(?:(?!(?:of|for|about|in|on|with|to|from|which|by|as|at|into|than|${DEFINITE_WORDS})\\b)[a-z0-9'-]+\\s+){0,2}`;
const WITHIN_CLAUSE = "[^.?!;:]{0,80}?";

// draw, sketch, chart, graph, plot, map and friends: the object only has to name a structure.
const DRAW_LIKE_VERB = "(?:draw|paint|sketch|chart|graph|plot|map|illustrate|depict|lay)(?:\\s+(?:out|up))?";
const DRAW_LIKE_DIAGRAM = new RegExp(
	`^${POLITE_PREFIX}${DRAW_LIKE_VERB}\\s+${OBJECT_HEAD}${DRAW_IDIOM_BLOCK}(?:(?=${WITHIN_CLAUSE}\\b${STRONG_DIAGRAM_NOUN}\\b)|(?=${MODIFIERS}${WEAK_DIAGRAM_NOUN}\\b))`
);

// "Diagram this" and "visualise the data" name the output in the verb, so any object will do.
const DIAGRAM_VERB = new RegExp(`^${POLITE_PREFIX}(?:diagram|visuali[sz]e)\\s+(?!(?:how|what|why|when|where|which|whether|if)\\b)[a-z0-9]`);

// Creation verbs need an indefinite object whose head is a diagram noun: "create a flowchart of login", not "make the chart bigger".
const CREATE_LIKE_VERB = "(?:create|make|generate|build|produce|design|draft|prepare|write|compose|construct|give|show)";
const CREATE_DIAGRAM = new RegExp(
	`^${POLITE_PREFIX}${CREATE_LIKE_VERB}\\s+${RECIPIENT}${INDEFINITE_DETERMINER}${MODIFIERS}${STRONG_DIAGRAM_NOUN}\\b`
);

// "Turn this note into a flowchart", "show the steps as a timeline".
const TRANSFORM_VERB = "(?:turn|convert|transform|express|represent|present|show|render|put)";
const TRANSFORM_DIAGRAM = new RegExp(
	`^${POLITE_PREFIX}${TRANSFORM_VERB}\\s+(?!(?:how|what|why|when|where|which|whether|if)\\b)${WITHIN_CLAUSE}\\b(?:into|as|to)\\s+(?:(?:an?|the)\\s+)?${MODIFIERS}(?:${STRONG_DIAGRAM_NOUN}|${WEAK_DIAGRAM_NOUN})\\b`
);

// "I need a flowchart of the login".
const NEED_DIAGRAM = new RegExp(`^(?:i\\s+(?:want|need)|i'd like|we\\s+need)\\s+(?:(?:an?|some|one)\\s+)?${MODIFIERS}${STRONG_DIAGRAM_NOUN}\\b`);

function normalizeQuestion(question: string): string {
	return question.toLowerCase().replace(/\s+/g, " ").trim();
}

export function hasExplicitImageCommand(question: string): boolean {
	return EXPLICIT_IMAGE_COMMAND.test(normalizeQuestion(question));
}

export function hasExplicitDiagramCommand(question: string): boolean {
	return EXPLICIT_DIAGRAM_COMMAND.test(normalizeQuestion(question));
}

function isVetoedBefore(text: string, index: number): boolean {
	const sentence = text.slice(Math.max(0, index - VETO_LOOKBACK), index).split(SENTENCE_BOUNDARY).pop() ?? "";
	return PICTURE_VETO_CUE.test(sentence) || hasTopicVerbBefore(sentence);
}

function namesPictureMedium(text: string): boolean {
	return MEDIUM_POSITIONS.some((pattern) =>
		Array.from(text.matchAll(pattern)).some((match) => !isVetoedBefore(text, match.index + (match[1]?.length ?? 0)))
	);
}

function asksForRasterPicture(normalized: string): boolean {
	return EXPLICIT_IMAGE_COMMAND.test(normalized) || namesPictureMedium(normalized);
}

/**
 * True when the question is an imperative request to draw, map, chart or outline a structure that Mermaid can show as text:
 * "draw a state machine", "map out the pipeline", "turn this note into a flowchart". Questions about diagrams ("how do I draw a
 * flowchart?") and explicit picture wording ("draw a picture of a roadmap", "/image") are not diagram requests.
 */
export function detectDiagramIntent(question: string): boolean {
	const normalized = normalizeQuestion(question);
	if (normalized.length === 0) return false;
	if (EXPLICIT_DIAGRAM_COMMAND.test(normalized)) return true;
	if (asksForRasterPicture(normalized)) return false;
	return (
		DRAW_LIKE_DIAGRAM.test(normalized) ||
		DIAGRAM_VERB.test(normalized) ||
		CREATE_DIAGRAM.test(normalized) ||
		TRANSFORM_DIAGRAM.test(normalized) ||
		NEED_DIAGRAM.test(normalized)
	);
}

// The matched span ends at the image noun. Only a negation right in front of that noun ("create a roadmap without an image") asks for
// text. Words further back describe the picture: "no smoking poster", "not found illustration", "text only logo", "how we work poster".
const NEGATED_IMAGE_NOUN = new RegExp(`(?<![\\w-])(?:no|not|without|never|nor|instead of|rather than)\\s+(?:(?:an?|any|the|some)\\s+)?${IMAGE_NOUN}$`);

function isCreateImageRequest(normalized: string): boolean {
	const match = CREATE_REQUEST.exec(normalized);
	return match !== null && !NEGATED_IMAGE_NOUN.test(match[0]);
}

export function isImperativeImageRequest(question: string): boolean {
	const normalized = normalizeQuestion(question);
	if (normalized.length === 0 || detectDiagramIntent(normalized)) return false;
	return isCreateImageRequest(normalized) || DRAW_REQUEST.test(normalized) || (DRAW_PICTURE_REQUEST.test(normalized) && asksForRasterPicture(normalized));
}

export function shouldGenerateImage(question: string, autoImageIntentEnabled: boolean): boolean {
	return hasExplicitImageCommand(question) || (autoImageIntentEnabled && isImperativeImageRequest(question));
}
