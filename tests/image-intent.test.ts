import { describe, expect, test } from "bun:test";
import { detectDiagramIntent, hasExplicitDiagramCommand, hasExplicitImageCommand, isImperativeImageRequest, shouldGenerateImage } from "../src/shared/imageIntent";

const imageRequests = [
	"Draw me a cat",
	"Generate an image of a cat with a caption",
	"/image a lighthouse",
	"/img a lighthouse",
	"Please create a picture of a sunset",
	"Can you generate 3 images of a fox in the snow?",
	"Could you please draw a red barn at dusk",
	"Design a logo for my brand",
	"Make me a watercolour painting of a harbour",
	"Paint a sunset over the sea",
	"Create a logo",
	"Generate a photo, realistic style",
	"Create an illustration showing the water cycle",
	"Make a poster and a matching banner",
	"Draw a lighthouse at dusk",
	// Hyphenated words are single words, so "how-to" and "no-background" are not cues to stay with text.
	"Make a how-to poster",
	"Create a no-background logo",
	// Words that describe the picture sit in front of the noun and are part of the request, whatever they are.
	"Design a no smoking poster",
	"Create a no entry icon",
	"Make a no parking sign icon",
	"Create a not found illustration for the 404 page",
	"Make a what's new banner for the release",
	"Design a how we work poster",
	"Create a text only logo",
	"Create a text-only logo",
	"Create a plain text logo",
	"Generate a no background logo",
	"Make a no code logo",
	"Create a dont panic poster",
	"Generate a don't panic poster",
	"Make a never forget poster",
	"Create a mermaid logo",
	"Generate a cute mermaid illustration"
];

const textRequests = [
	"How do I design a logo for my brand?",
	"What does this image make you think of?",
	"Explain why the thumbnail doesn't render",
	"Make sure the picture captions are consistent",
	"Rewrite the drawing instructions to make them clearer",
	"Make a list of the key points in the photo section",
	"Make the image smaller",
	"Create an image prompt for a lighthouse",
	"Generate alt text for this image",
	"Generate a caption for this picture",
	"Draw a conclusion from these notes",
	"Draw the line between facts and opinions",
	"Draw a mermaid diagram of the workflow",
	"Draw up a plan for next week",
	"Draw a pie chart of sales",
	"Draw a bar chart",
	"Draw a sequence diagram of login",
	"Draw a class diagram",
	"Draw a UML diagram",
	"Draw a venn diagram",
	"Draw a gantt chart",
	"Draw a 3-column table",
	"Draw me conclusions from this",
	"Summarise the photo section",
	"Generate a photo checklist",
	"Generate logo ideas for my bakery",
	"Create a poster outline",
	"Design a logo brief",
	"Make a banner text for my README",
	"Generate a YouTube thumbnail text",
	"Generate a sketch outline of the essay",
	"Create some image ideas",
	// A negation in front of the image noun is a request for text, also for the create verbs.
	"Create a roadmap without an image",
	"Make a table without a picture",
	"Generate a list not an image",
	"Create a document without any image",
	"Create a list no picture",
	"Design a table not a poster",
	"",
	"   "
];

describe("isImperativeImageRequest", () => {
	test.each(imageRequests.filter((question) => !question.startsWith("/")))("treats %p as an image request", (question) => {
		expect(isImperativeImageRequest(question)).toBe(true);
	});

	test.each(textRequests)("treats %p as a text request", (question) => {
		expect(isImperativeImageRequest(question)).toBe(false);
	});
});

describe("shouldGenerateImage", () => {
	test.each(imageRequests)("generates an image for %p when auto-detection is on", (question) => {
		expect(shouldGenerateImage(question, true)).toBe(true);
	});

	test.each(textRequests)("keeps %p as text when auto-detection is on", (question) => {
		expect(shouldGenerateImage(question, true)).toBe(false);
	});

	test("only the explicit command counts when auto-detection is off", () => {
		expect(shouldGenerateImage("/image a lighthouse", false)).toBe(true);
		expect(shouldGenerateImage("  /IMG a lighthouse", false)).toBe(true);
		expect(shouldGenerateImage("Draw me a cat", false)).toBe(false);
		expect(shouldGenerateImage("Please create a picture of a sunset", false)).toBe(false);
	});
});

describe("hasExplicitImageCommand", () => {
	test("requires the command at the start", () => {
		expect(hasExplicitImageCommand("/image a lighthouse")).toBe(true);
		expect(hasExplicitImageCommand("use /image a lighthouse")).toBe(false);
		expect(hasExplicitImageCommand("/imagine a lighthouse")).toBe(false);
	});
});

// An image word behind a verb clause about the topic ("the app saving a note as an image") is not the medium. None of these phrases
// contains a negation or a subordinate-clause cue (how, what, when, that, ...), so only the verb clause protects them.
const topicClauseRequests = [
	"draw a flowchart of the app saving a note as an image",
	"draw a flowchart of the app saving notes as images",
	"draw a flowchart for exporting notes as images",
	"draw a flowchart for saving the diagram as a png",
	"draw a flowchart of the steps to export a note as a png",
	"draw a flowchart for note export as png",
	"draw a flowchart to export the note as a png",
	"draw a sequence diagram for uploading a file in png format",
	"draw a sequence diagram of a user uploading a file in png format",
	"draw a diagram showing notes saved as images",
	"draw a flowchart for storing avatars as jpeg",
	"draw a flowchart for a photo upload feature in png and jpg",
	"draw a flowchart for the upload of a file as an image",
	"draw a flowchart for the user to download a diagram as a png",
	"draw a flowchart for a user's file download in png format",
	"draw a flowchart for the app's save feature in png format",
	"draw a flowchart of a user opening a note as an image",
	"draw a flowchart of users viewing notes as pictures",
	"draw a flowchart for resizing an image as a png",
	"draw a flowchart for editing a photo as a png",
	"draw a flowchart: the user saves a note as an image",
	"draw a flowchart, the user exports a diagram as a png",
	"draw a flowchart so users can save a note as an image",
	"draw a flowchart and export the note as a png",
	"draw a flowchart for uploading and exporting notes as images",
	"draw a flowchart for uploading, saving and exporting notes as images",
	"draw a flowchart of a note being exported as a png",
	"draw a state machine for a bot posting a diagram as an image",
	"draw a flowchart for the app saving a roadmap image",
	"draw a flowchart for (saving notes) as images",
	"draw a flowchart for upload/download as png",
	"draw a diagram of exported notes as images",
	// The same wording with the other verbs reaches the diagram path too, instead of dropping out of both routes.
	"make a diagram of the app saving a note as an image",
	"create a flowchart of the app saving a note as an image",
	"visualize the app saving a note as an image",
	"Generate a state machine for exporting notes as images"
];

// DGM-01: diagram wording must reach Mermaid, never paid image generation.
const diagramRequests = [
	"draw a state machine for the checkout flow",
	"draw a roadmap",
	"draw a decision tree",
	"draw an architecture overview of this note",
	"draw a concept map",
	"draw a user journey",
	"draw a workflow",
	"draw a network topology",
	"draw a kanban board",
	"draw an ER model",
	"draw a gantt for the roadmap",
	"Draw a pipeline",
	"Draw a lifecycle for a support ticket",
	"Draw the hierarchy of this org",
	"Draw a swimlane for the release process",
	"Draw a schema for the notes database",
	"Draw a high level architecture of the plugin",
	"Draw me a flow for onboarding",
	"Sketch the architecture of this service",
	"Sketch a roadmap for next quarter",
	"Please draw a timeline of the project",
	"Could you draw a mind map of this note?",
	"Can you map out the pipeline?",
	"Draw up a roadmap for Q4",
	"Paint a roadmap of the year",
	"Draw a pie chart of sales",
	"Draw a sequence diagram of login",
	"Draw a mermaid diagram of the workflow",
	"Draw a flowchart",
	"Diagram this note",
	"Please diagram the login flow",
	"Visualise the data flow",
	"Visualize this note as a graph",
	"Create a flowchart of the login",
	"Make a state machine for the order lifecycle",
	"Generate a chart of the sales data",
	"Create a graph of sales by month",
	"I need a chart of the sales data",
	"Generate a gantt chart for the release plan",
	"Build a mind map from these headings",
	"Give me a diagram of how the modules fit together",
	"Show me a sequence diagram of the request",
	"Turn this note into a flowchart",
	"Convert the steps into a timeline",
	"Show the process as a flowchart",
	"Put this into a mind map",
	"I need a flowchart of the login",
	"/diagram the release process",
	// An image word that names the topic, not the medium, is still diagram work.
	"Draw a pipeline for the image processing",
	"Draw a roadmap for the photo app",
	"Draw a state machine for the photo upload flow",
	"Draw a diagram of the image",
	"Draw an architecture overview of the image classifier",
	"Draw a flowchart of this picture",
	// A picture, photo or image that is what the diagram is about, wherever it sits in the phrase, is still diagram work.
	"draw a diagram of the big picture",
	"draw a flowchart that shows the full picture",
	"draw a flowchart for uploading a photo",
	"draw a flowchart of how to resize an image",
	"draw a sequence diagram for loading an image",
	"draw a diagram of how the app stores an image",
	"draw a flowchart for converting jpg to png",
	"draw a flowchart of what happens to a photo",
	"draw a chart of photos",
	"draw a timeline of an image",
	"draw a flowchart for designing a poster",
	"draw a diagram of the people in a photo",
	"draw a flowchart of the process as seen in the picture",
	"draw a state machine for a photo editor",
	"draw a pipeline for resizing images and photos",
	"draw a sequence diagram of how a poster is uploaded",
	"draw a flowchart of the picture upload flow",
	// Negated picture wording is a request for text, however the negation is phrased.
	"draw a flowchart, not as an image",
	"draw a flowchart and don't make it an image",
	"draw a flowchart, I don't want a picture",
	"draw a flowchart in mermaid not as a picture",
	"Draw a flowchart, text please, not as a picture",
	"Draw a roadmap but never as a PNG",
	"Draw a state machine without rendering it as an image",
	"Draw a pipeline, please avoid exporting it as a picture",
	"Draw a workflow. Do not render it as an image.",
	"Draw a flowchart, skip the image, as a png",
	"Draw a flowchart, don't render it as an image",
	"Draw a flowchart, don’t render it as an image",
	// A subordinate-clause cue vetoes the medium as well, on top of the verb clause.
	"draw a flowchart of how the app saves a note as an image",
	"draw a sequence diagram of what happens when a user uploads a file in png format",
	...topicClauseRequests
];

// Explicit picture wording outranks diagram nouns.
const pictureRequests = [
	// The request's own command verb is never a topic verb, whatever its object starts with.
	"create me a flowchart image",
	"generate us a kanban poster",
	"produce me a diagram poster",
	"create two flowchart images",
	"create 3 state machine pictures",
	"Could you please create me a state machine image",
	"create colourful kanban board image",
	"draw a picture of a roadmap",
	"Draw an illustration of the workflow",
	"Generate an image of a state machine",
	"Create an illustration of the architecture",
	"Paint a picture of a tree",
	"Please draw a photo of a kanban board",
	"Generate a picture of a network topology",
	"Draw me a cat holding a map",
	"Draw a lighthouse next to a pipeline",
	// Picture wording after the structural noun is just as explicit as wording before it.
	"draw a state machine as an image",
	"draw a state machine as a picture",
	"draw a state machine image",
	"draw a roadmap poster",
	"draw a pretty roadmap as an image",
	"Draw a flowchart as a PNG",
	"Paint a roadmap as an illustration",
	"Draw a kanban board as a jpeg",
	"Please draw an architecture overview as a picture",
	"Draw a workflow in png format",
	"Draw a pie chart as an image, high resolution",
	"Draw a table as an image",
	"Can you draw a network topology as a PNG please?",
	// The medium can also be named by a modifier-laden phrase, "in" after the structure, or an image noun at the head of the object.
	"draw a roadmap in an image",
	"draw a state machine in a picture",
	"draw an architecture overview as a high resolution png",
	"draw a workflow as a 4k image",
	"draw a roadmap as png",
	"draw a state machine as a no-background png",
	"draw an image of a state machine",
	"Draw a kanban board image of the sprint",
	// A negation in an earlier sentence does not veto a later, explicit request for the medium.
	"Draw a roadmap, not a table. Export it as a PNG.",
	// A delivery instruction is the medium: plain noun phrases, a clause break, or a command that acts on the diagram itself.
	"draw a diagram of our architecture as a picture",
	"draw a roadmap as a png",
	"draw a flowchart and render it as an image",
	"draw a flowchart and save as png",
	"draw a flowchart and render the diagram as an image",
	"draw a flowchart of the login flow and render it as a png",
	"draw a flowchart of the app saving a note and then render it as an image",
	"draw a flowchart of the app saving a note, as an image",
	"draw a roadmap then save it as a picture",
	"draw a pipeline of the checkout, as a png",
	// Verbs that say what the diagram shows or is for, and nouns that merely look like verbs, do not turn the medium into a topic.
	"draw a sequence diagram to show the login process as an image",
	"draw a flowchart showing milestones as a png",
	"draw a flowchart from login to checkout as a png",
	"draw a roadmap to production as a png",
	"draw a kanban board with arrows as an image",
	"draw an architecture overview for onboarding as a picture",
	"draw a flowchart for the new billing service as a png",
	"draw a state machine of the data processing pipeline as a png",
	"draw a flowchart for the export screen as a png",
	"draw a flowchart of the downloads page as a png",
	"create a state machine image",
	"create a sequence diagram poster"
];

const notDiagramRequests = [
	"How do I draw a flowchart in Mermaid?",
	"What is a state machine?",
	"Explain the difference between a pie chart and a bar chart",
	"Why does my gantt chart not render?",
	"Write a caption for this chart",
	"Make the chart bigger",
	"Summarise the roadmap",
	"Draw a conclusion from the workflow",
	"Draw attention to the pipeline",
	"Draw conclusions from the architecture notes",
	"Draw up a plan for next week",
	"Draw the line between facts and opinions",
	"Draw on the architecture notes for the answer",
	"Draw out the key points of the roadmap",
	"Draw a lighthouse at dusk",
	"Draw me a cat",
	"Rewrite the flowchart labels",
	"Show how to use a flowchart",
	"Explain this as a diagram",
	"Make a list of the diagrams in this note",
	"Translate this diagram into French",
	"Convert this to a table",
	"Create a summary of the roadmap",
	"Design a logo for my brand",
	"Generate an image of a cat",
	"/image a roadmap",
	"/diagrams are great",
	// A diagram noun that modifies a longer noun phrase is ordinary writing, not a drawing request.
	"Generate a chart of accounts template",
	"Generate a chart of accounts template for this note",
	"Create a chart of accounts for a bakery",
	"Create a diagram description for alt text",
	"Write a diagram caption",
	"write a graph of thoughts essay",
	"Write a graph theory summary",
	"Draft a graph neural network explainer",
	"Create a graph database schema",
	"I need a diagram caption for the figure",
	"",
	"   "
];

describe("detectDiagramIntent", () => {
	test.each(diagramRequests)("treats %p as a diagram request", (question) => {
		expect(detectDiagramIntent(question)).toBe(true);
	});

	test.each(pictureRequests)("leaves %p to image generation", (question) => {
		expect(detectDiagramIntent(question)).toBe(false);
	});

	test.each(notDiagramRequests)("does not treat %p as a diagram request", (question) => {
		expect(detectDiagramIntent(question)).toBe(false);
	});

	test("explicit picture wording wins unless it is negated", () => {
		expect(detectDiagramIntent("Create a diagram, not a picture")).toBe(true);
		expect(detectDiagramIntent("Draw a flowchart instead of an image")).toBe(true);
		expect(detectDiagramIntent("Draw a flowchart as a PNG")).toBe(false);
		expect(shouldGenerateImage("Draw a flowchart as a PNG", true)).toBe(true);
		expect(shouldGenerateImage("Draw a flowchart instead of an image", true)).toBe(false);
		expect(shouldGenerateImage("Draw a table, not a picture", true)).toBe(false);
	});

	test("an image word that is the topic, not the medium, does not count as picture wording", () => {
		expect(detectDiagramIntent("Draw a pipeline for the image processing")).toBe(true);
		expect(detectDiagramIntent("Draw a roadmap for the photo app")).toBe(true);
		expect(detectDiagramIntent("Draw a diagram of the image")).toBe(true);
		expect(shouldGenerateImage("Draw a pipeline for the image processing", true)).toBe(false);
		expect(shouldGenerateImage("Draw a list of the photo section", true)).toBe(false);
	});

	test("the /diagram command is explicit", () => {
		expect(hasExplicitDiagramCommand("/diagram the release process")).toBe(true);
		expect(hasExplicitDiagramCommand("  /DIAGRAM")).toBe(true);
		expect(hasExplicitDiagramCommand("use /diagram here")).toBe(false);
		expect(hasExplicitDiagramCommand("/diagrams")).toBe(false);
	});
});

describe("diagram wording never reaches paid image generation", () => {
	test.each(diagramRequests.filter((question) => !question.startsWith("/")))("keeps %p as text when auto-detection is on", (question) => {
		expect(shouldGenerateImage(question, true)).toBe(false);
		expect(isImperativeImageRequest(question)).toBe(false);
	});

	test.each(["draw a roadmap", "Draw a tree", "Draw a map of the area", "Draw a data structure", "Draw a table of results"])(
		"blocks the bare structural noun in %p",
		(question) => {
			expect(shouldGenerateImage(question, true)).toBe(false);
		}
	);

	test.each(pictureRequests)("still generates an image for %p", (question) => {
		expect(shouldGenerateImage(question, true)).toBe(true);
	});

	// Every structural subject, with picture wording in any position, reaches exactly one path: image generation.
	// The routes must never leave a draw request in neither bucket.
	const subjects = [
		"a state machine",
		"a roadmap",
		"an architecture overview",
		"a workflow",
		"a user journey",
		"a network topology",
		"a kanban board",
		"a gantt chart",
		"a flowchart",
		"a decision tree",
		"a concept map",
		"a pipeline",
		"a lifecycle",
		"a hierarchy",
		"a swimlane",
		"a schema",
		"a timeline",
		"a sequence diagram",
		"a pie chart",
		"a table"
	];
	const trailingWording = ["as an image", "as a picture", "as a PNG", "as a JPEG", "in png format", "image", "poster"];
	const drawVerbs = ["draw", "paint"];
	const trailingCases = drawVerbs.flatMap((verb) => subjects.flatMap((subject) => trailingWording.map((wording) => `${verb} ${subject} ${wording}`)));

	test.each(trailingCases)("routes %p to image generation and not to the diagram path", (question) => {
		expect(shouldGenerateImage(question, true)).toBe(true);
		expect(detectDiagramIntent(question)).toBe(false);
	});

	// An image word that is the topic ("for uploading a photo") or sits in a clause about the subject ("of what happens to a photo")
	// is not a request for a picture, whichever structural subject comes before it.
	const topicTails = [
		"of the big picture",
		"that shows the full picture",
		"for uploading a photo",
		"of how to resize an image",
		"for loading an image",
		"of how the app stores an image",
		"for converting jpg to png",
		"of what happens to a photo",
		"for designing a poster",
		"of the people in a photo",
		"for the image processing",
		"for the photo app",
		"of this picture",
		"of photos",
		"of an image"
	];
	const topicCases = drawVerbs.flatMap((verb) => subjects.flatMap((subject) => topicTails.map((tail) => `${verb} ${subject} ${tail}`)));

	test.each(topicCases)("keeps %p as text because the image word is the topic", (question) => {
		expect(shouldGenerateImage(question, true)).toBe(false);
		expect(isImperativeImageRequest(question)).toBe(false);
	});

	// "a table" is the one subject that is text work but not a diagram noun, so it is excluded from the diagram-path check.
	const diagramTopicCases = drawVerbs.flatMap((verb) =>
		subjects.filter((subject) => subject !== "a table").flatMap((subject) => topicTails.map((tail) => `${verb} ${subject} ${tail}`))
	);

	test.each(diagramTopicCases)("sends %p to the diagram path", (question) => {
		expect(detectDiagramIntent(question)).toBe(true);
	});

	// The veto covers the whole sentence in front of the medium word, not only the word right before it.
	const negatedTails = [
		", not as an image",
		", I don't want it as a picture",
		" in mermaid not as a picture",
		", text please, not as a picture",
		", never as a png",
		" and please avoid exporting it as an image",
		", skip the image and give me text only, as a png",
		" without rendering it as a photo",
		", rather than as an illustration",
		" instead of as a poster",
		", no pictures, just text, as an image",
		" and it cannot be an image"
	];
	const negatedCases = drawVerbs.flatMap((verb) => subjects.flatMap((subject) => negatedTails.map((tail) => `${verb} ${subject}${tail}`)));

	test.each(negatedCases)("keeps %p as text because the picture wording is negated", (question) => {
		expect(shouldGenerateImage(question, true)).toBe(false);
		expect(isImperativeImageRequest(question)).toBe(false);
	});

	// A verb clause in front of "as an image" or "in png format" is a topic, whichever subject and verb come before it. None of the tails
	// uses a negation or a subordinate-clause cue, so the cue list cannot be what keeps them on the text path.
	const topicClauseTails = [
		" of the app saving a note as an image",
		" of the app saving notes as images",
		" for exporting notes as images",
		" for saving the diagram as a png",
		" of the steps to export a note as a png",
		" for note export as png",
		" to export the note as a png",
		" for uploading a file in png format",
		" of a user uploading a file in png format",
		" showing notes saved as images",
		" for storing avatars as jpeg",
		" for a photo upload feature in png and jpg",
		" of a user opening a note as a picture",
		" for converting notes to images as png",
		" of users sharing photos as png",
		" for the download of a diagram as a jpeg",
		" for users to save notes as pictures",
		" so users can save a note as a poster",
		" of the exporter writing a file in png format",
		" with notes uploaded as pictures",
		", the user saves a note as an image",
		" and export the note as a png"
	];
	const cueWord = /(?<![\w-])(?:no|not|never|without|avoid|skip|instead|rather|nor|cannot|dont|text|mermaid|how|what|when|where|why|whether|which|who|that)(?![\w-])|n['’]t/;

	test("the verb clause tails and requests carry no veto cue", () => {
		[...topicClauseTails, ...topicClauseRequests].forEach((phrase) => expect(cueWord.test(phrase.toLowerCase())).toBe(false));
	});

	const topicClauseCases = drawVerbs.flatMap((verb) => subjects.flatMap((subject) => topicClauseTails.map((tail) => `${verb} ${subject}${tail}`)));

	test.each(topicClauseCases)("keeps %p as text because a verb clause owns the image word", (question) => {
		expect(shouldGenerateImage(question, true)).toBe(false);
		expect(isImperativeImageRequest(question)).toBe(false);
	});

	// The other verbs reach the diagram path with the same wording; "a table" and "a roadmap" are not strong diagram nouns for them.
	const strongSubjects = ["a state machine", "a flowchart", "a gantt chart", "a sequence diagram", "a pie chart", "a mind map", "a kanban board", "a diagram"];
	const topicClauseDiagramCases = [...drawVerbs, "make", "create", "generate", "visualize"].flatMap((verb) =>
		strongSubjects.flatMap((subject) => topicClauseTails.map((tail) => `${verb} ${subject}${tail}`))
	);

	test.each(topicClauseDiagramCases)("sends %p to the diagram path", (question) => {
		expect(detectDiagramIntent(question)).toBe(true);
		expect(shouldGenerateImage(question, true)).toBe(false);
	});

	// Wording that says how to deliver the diagram stays the medium, also behind a topic.
	const mediumTails = [
		" and render it as an image",
		" and save it as a png",
		" and render the diagram as an image",
		", as an image",
		" then save it as a picture",
		" of our architecture as a picture",
		" of the login flow and render it as a png",
		" from login to checkout as a png",
		" to show the login process as an image",
		" showing milestones as a png",
		" for the new billing service as a png",
		" of the data processing pipeline as a png",
		" for the export screen as a png",
		" for onboarding as a picture",
		" to production as a png",
		" with arrows as an image"
	];
	const mediumCases = drawVerbs.flatMap((verb) => subjects.flatMap((subject) => mediumTails.map((tail) => `${verb} ${subject}${tail}`)));

	test.each(mediumCases)("routes %p to image generation", (question) => {
		expect(shouldGenerateImage(question, true)).toBe(true);
		expect(detectDiagramIntent(question)).toBe(false);
	});

	// Create verbs: descriptive words in front of the noun are part of the picture, a negation right in front of the noun is not.
	const describedPictures = ["no smoking", "not found", "text only", "plain text", "no background", "how we work", "what's new", "never forget", "dont panic", "mermaid", "no entry"];
	const pictureNouns = ["poster", "logo", "icon", "banner", "illustration"];
	const createVerbs = ["Create", "Make", "Generate", "Design"];
	const describedCases = createVerbs.flatMap((verb) => describedPictures.flatMap((described) => pictureNouns.map((noun) => `${verb} a ${described} ${noun}`)));

	test.each(describedCases)("treats %p as an image request", (question) => {
		expect(isImperativeImageRequest(question)).toBe(true);
		expect(shouldGenerateImage(question, true)).toBe(true);
	});

	const textSubjects = ["roadmap", "table", "list", "document", "summary"];
	const negations = ["without an image", "without any picture", "not an image", "not a photo", "no picture", "rather than a poster", "instead of an image"];
	const negatedCreateCases = createVerbs.flatMap((verb) => textSubjects.flatMap((subject) => negations.map((negation) => `${verb} a ${subject} ${negation}`)));

	test.each(negatedCreateCases)("keeps %p as text", (question) => {
		expect(shouldGenerateImage(question, true)).toBe(false);
	});

	test("an auto-detected trailing picture request still needs the setting", () => {
		expect(shouldGenerateImage("draw a state machine as an image", false)).toBe(false);
	});

	test("the explicit image command still wins over diagram wording", () => {
		expect(shouldGenerateImage("/image a roadmap", false)).toBe(true);
		expect(shouldGenerateImage("/img draw a state machine", false)).toBe(true);
	});
});

describe("intent detection stays fast on hostile input", () => {
	test("long inputs finish within a small time budget", () => {
		const inputs = [
			`draw a ${"very ".repeat(20000)}roadmap`,
			`please ${"a ".repeat(30000)}`,
			`turn ${"this ".repeat(20000)}into a flowchart`,
			"draw ".repeat(20000),
			`draw a roadmap ${"not as an image ".repeat(20000)}`,
			`draw a roadmap ${"as an image, ".repeat(20000)}`,
			`draw a ${"roadmap image ".repeat(20000)}`,
			`draw a roadmap ${"as a ".repeat(30000)}png`,
			`create a ${"no ".repeat(30000)}image`,
			`draw a roadmap ${"for uploading a file as an image, ".repeat(20000)}`,
			`draw a roadmap ${"for saving notes and ".repeat(20000)}as an image`,
			`draw a roadmap ${"to ".repeat(60000)}as an image`,
			`draw a roadmap ${"from a to ".repeat(30000)}as an image`,
			`draw a flowchart of ${"saving ".repeat(40000)}as a png`,
			`draw a flowchart ${", ".repeat(60000)}as a png`
		];
		const started = performance.now();
		inputs.forEach((input) => {
			detectDiagramIntent(input);
			isImperativeImageRequest(input);
		});
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
