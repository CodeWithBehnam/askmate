// Image generation costs money and needs an OpenAI key, so detection is deliberately strict:
// only an explicit command or an imperative request at the very start of the question counts.
// Definite objects ("make the image smaller", "draw the line") usually refer to existing content, so
// only indefinite objects ("a", "an", "some", a number) count as a request for a new image.

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

// "Draw" and "paint" are visual on their own, except in idioms and in text-diagram requests.
// The lookahead and back-reference make the recipient and determiner atomic, so the object check
// cannot be bypassed by backtracking over "a" or "me".
const DRAW_VERB = "(?:draw|paint)";
const DRAW_OBJECT_BLOCK = `(?!(?:on|from|up|out|upon|in|into|attention|conclusions?|comparisons?|parallels?|distinctions?|lines?|inferences?|insights?|lessons?|connections?|diagrams?|charts?|graphs?|tables?|flowcharts?|mind|mindmaps?|timelines?|outlines?|plans?|lists?|summary|summaries|mermaid|ascii|${DEFINITE_WORDS})\\b)`;
const DRAW_REQUEST = new RegExp(
	`^${POLITE_PREFIX}${DRAW_VERB}\\s+(?=(${RECIPIENT}${INDEFINITE_DETERMINER}))\\1${DRAW_OBJECT_BLOCK}[a-z0-9]`
);

const EXPLICIT_IMAGE_COMMAND = /^\/(?:image|img)\b/;

function normalizeQuestion(question: string): string {
	return question.toLowerCase().replace(/\s+/g, " ").trim();
}

export function hasExplicitImageCommand(question: string): boolean {
	return EXPLICIT_IMAGE_COMMAND.test(normalizeQuestion(question));
}

export function isImperativeImageRequest(question: string): boolean {
	const normalized = normalizeQuestion(question);
	return normalized.length > 0 && (CREATE_REQUEST.test(normalized) || DRAW_REQUEST.test(normalized));
}

export function shouldGenerateImage(question: string, autoImageIntentEnabled: boolean): boolean {
	return hasExplicitImageCommand(question) || (autoImageIntentEnabled && isImperativeImageRequest(question));
}
