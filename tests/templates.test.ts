import { describe, expect, test } from "bun:test";
import { buildDateTemplateValues, renderTemplate, trimOuterBlankLines } from "../src/output/templates";

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

describe("buildDateTemplateValues", () => {
	test("date and dateTime share the local calendar day and carry the offset", () => {
		// 00:30 on 11 Oct at UTC+01:00 is still 10 Oct in UTC, which is where the old values disagreed.
		const instant = new Date("2026-10-10T23:30:00Z");
		const values = buildDateTemplateValues(instant, -60);
		expect(values.date).toBe("2026-10-11");
		expect(values.dateTime).toBe("2026-10-11T00:30:00+01:00");
		expect(values.dateTime.startsWith(values.date)).toBe(true);
	});

	test("formats negative and zero offsets", () => {
		const instant = new Date("2026-01-02T03:04:05Z");
		expect(buildDateTemplateValues(instant, 330).dateTime).toBe("2026-01-01T21:34:05-05:30");
		expect(buildDateTemplateValues(instant, 0).dateTime).toBe("2026-01-02T03:04:05+00:00");
	});
});
