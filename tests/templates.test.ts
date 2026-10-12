import { describe, expect, test } from "bun:test";
import { analyzeTemplate, buildDateTemplateValues, closeOpenFencesInVariables, renderTemplate, trimOuterBlankLines } from "../src/output/templates";

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

describe("analyzeTemplate", () => {
	const known = ["title", "request", "response", "date"];

	test("lists the placeholders in order of first use", () => {
		const analysis = analyzeTemplate("# {{title}}\n\n{{ response }}\n{{title}} {{request}}", known);
		expect(analysis.placeholders).toEqual(["title", "response", "request"]);
		expect(analysis).toMatchObject({ unknown: [], missingRequired: [], literal: [] });
	});

	test("flags placeholders that would silently render empty", () => {
		const analysis = analyzeTemplate("{{title}} {{respnse}} {{Title}} {{ date }}", known);
		expect(analysis.unknown).toEqual(["respnse", "Title"]);
	});

	test("flags required placeholders the template never uses", () => {
		expect(analyzeTemplate("# {{title}}", known, ["response", "title"]).missingRequired).toEqual(["response"]);
		expect(analyzeTemplate("{{response}}", known, ["response"]).missingRequired).toEqual([]);
		expect(analyzeTemplate("", known, ["response"]).missingRequired).toEqual(["response"]);
	});

	test("lists brace text that is kept as written because it is not a placeholder", () => {
		const analysis = analyzeTemplate("{{date:YYYY-MM-DD}} {{#each items}} {{ }} {{title}} {{unclosed", known);
		expect(analysis.literal).toEqual(["{{date:YYYY-MM-DD}}", "{{#each items}}", "{{ }}", "{{unclosed"]);
		expect(analysis.placeholders).toEqual(["title"]);
	});

	test("accepts any iterable and never reports a known name twice", () => {
		const analysis = analyzeTemplate("{{x}}{{x}}{{y}}{{y}}", new Set(["x"]), new Set(["z"]));
		expect(analysis).toMatchObject({ placeholders: ["x", "y"], unknown: ["y"], missingRequired: ["z"] });
	});

	test("is linear on long input", () => {
		const started = performance.now();
		analyzeTemplate("{{".repeat(50000), known);
		analyzeTemplate(`{{${"a".repeat(100000)}`, known);
		expect(performance.now() - started).toBeLessThan(300);
	});
});

describe("closeOpenFencesInVariables", () => {
	const template = ["# {{title}}", "", "## Request", "", "{{request}}", "", "## Response", "", "{{response}}"].join("\n");

	test("an unclosed fence in the request cannot swallow the response", () => {
		const raw = renderTemplate(template, { title: "T", request: "Explain this:\n```js\nfoo(", response: "The answer." });
		expect(raw.match(/^```/gm)).toHaveLength(1);
		const safe = renderTemplate(template, closeOpenFencesInVariables({ title: "T", request: "Explain this:\n```js\nfoo(", response: "The answer." }, ["request", "response"]));
		expect(safe.match(/^```/gm)).toHaveLength(2);
		expect(safe.indexOf("## Response")).toBeGreaterThan(safe.lastIndexOf("```"));
	});

	test("only the named variables change, and balanced text is untouched", () => {
		const variables = { request: "```\nx", response: "```\ny\n```", folder: "```" };
		const result = closeOpenFencesInVariables(variables, ["request", "response"]);
		expect(result).toEqual({ request: "```\nx\n```", response: "```\ny\n```", folder: "```" });
		expect(variables.request).toBe("```\nx");
		expect(closeOpenFencesInVariables({}, ["request"])).toEqual({});
	});
});
