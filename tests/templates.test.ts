import { describe, expect, test } from "bun:test";
import { renderTemplate, trimOuterBlankLines } from "../src/output/templates";

describe("renderTemplate", () => {
	test("inserts content verbatim, including {{ }} lines, blank-line runs and indentation", () => {
		const response = [
			"    indented code line",
			"```handlebars",
			"{{date:YYYY-MM-DD}}",
			"{{#each items}}",
			"{{ title }}",
			"```",
			"",
			"",
			"",
			"",
			"After four blank lines"
		].join("\n");

		expect(renderTemplate("{{response}}", { response })).toBe(response);
		expect(renderTemplate("## Response\n\n{{response}}\n", { response })).toBe(`## Response\n\n${response}\n`);
	});

	test("drops template lines made only of placeholders that rendered empty", () => {
		const template = ["# {{title}}", "Output mode: {{outputMode}}", "{{workflowLine}}", "", "## Request", "{{revisedPromptSection}}  {{unknown}}", "End"].join("\n");

		expect(renderTemplate(template, { title: "Note", outputMode: "Chat", workflowLine: "", revisedPromptSection: "" })).toBe(
			["# Note", "Output mode: Chat", "", "## Request", "End"].join("\n")
		);
	});

	test("keeps placeholder-only lines that rendered content and lines with literal text", () => {
		const template = ["{{workflowLine}}", "Workflow: {{workflowName}}", "{{a}} {{b}}"].join("\n");

		expect(renderTemplate(template, { workflowLine: "Workflow: Summarise", workflowName: "", a: "", b: "x" })).toBe(
			["Workflow: Summarise", "Workflow: ", " x"].join("\n")
		);
	});

	test("keeps template blank lines and non-placeholder brace syntax", () => {
		expect(renderTemplate("A\n\n\n\nB\n{{date:YYYY}}", {})).toBe("A\n\n\n\nB\n{{date:YYYY}}");
	});

	test("does not expand substituted values or special replacement patterns", () => {
		expect(renderTemplate("{{response}}", { response: "{{title}} costs $& and $1", title: "Injected" })).toBe(
			"{{title}} costs $& and $1"
		);
	});

	test("ignores inherited object properties", () => {
		expect(renderTemplate("Value: {{constructor}}", {})).toBe("Value: ");
	});
});

describe("trimOuterBlankLines", () => {
	test("removes surrounding blank lines but keeps first-line indentation", () => {
		expect(trimOuterBlankLines("\n  \n    code\n\n")).toBe("    code");
	});
});
