import { describe, expect, test } from "bun:test";
import { hasExplicitImageCommand, isImperativeImageRequest, shouldGenerateImage } from "../src/shared/imageIntent";

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
	"Make a poster and a matching banner"
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
