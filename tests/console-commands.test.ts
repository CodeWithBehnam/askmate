import { describe, expect, test } from "bun:test";
import {
	buildConsoleCommands,
	extractConsoleMentions,
	resolveLayoutName,
	formatConsoleHelp,
	formatConsoleStatus,
	getConsoleCompletions,
	parseConsoleInput,
	slugifyCommandName
} from "../src/ui/sidebar/consoleCommands";
import { WORKFLOWS } from "../src/workflows/builtInWorkflows";
import type { Workflow } from "../src/shared/types";

const commands = buildConsoleCommands(WORKFLOWS);

function custom(id: string, shortName: string, name = shortName): Workflow {
	return {
		id,
		commandId: `custom:${id}`,
		name,
		shortName,
		description: name,
		icon: "wand-2",
		accent: "slate",
		prompt: "Do it",
		isCustom: true
	};
}

describe("buildConsoleCommands", () => {
	test("every built-in workflow gets a unique command named after its short name", () => {
		const workflowCommands = commands.filter((command) => command.kind === "workflow");
		expect(workflowCommands).toHaveLength(WORKFLOWS.length);
		expect(workflowCommands.map((command) => command.name)).toContain("polish");
		expect(workflowCommands.map((command) => command.name)).toContain("pros-cons");
		const names = commands.flatMap((command) => [command.name, ...command.aliases]);
		expect(new Set(names).size).toBe(names.length);
	});

	test("a workflow whose short name clashes with a built-in command falls back to its id", () => {
		const built = buildConsoleCommands([custom("custom-help-1", "Help"), custom("custom-a", "Polish"), custom("custom-b", "Polish")]);
		const workflowNames = built.filter((command) => command.kind === "workflow").map((command) => command.name);
		expect(workflowNames).toEqual(["custom-help-1", "polish", "custom-b"]);
	});

	test("slugs drop accents and punctuation", () => {
		expect(slugifyCommandName("Pros/Cons")).toBe("pros-cons");
		expect(slugifyCommandName("Résumé Builder!")).toBe("resume-builder");
	});
});

describe("extractConsoleMentions", () => {
	test("reads scope, folder and note mentions and removes them from the text", () => {
		const result = extractConsoleMentions('fix tone @selection @folder:"Projects/Q3 Plans" @[[Vendors|vendor list]]');
		expect(result.error).toBeNull();
		expect(result.text).toBe("fix tone");
		expect(result.mentions).toEqual({ scope: "selection", folder: "Projects/Q3 Plans", notes: ["Vendors"] });
	});

	test("@folder alone means the folder from settings", () => {
		expect(extractConsoleMentions("summarise @folder").mentions.folder).toBe("");
	});

	test("email addresses and unknown @words are left alone", () => {
		const result = extractConsoleMentions("email me@example.com about @weekly");
		expect(result.text).toBe("email me@example.com about @weekly");
		expect(result.mentions).toEqual({ scope: "auto", folder: null, notes: [] });
	});

	test("mentions may be followed by punctuation", () => {
		expect(extractConsoleMentions("Summarise @note.")).toEqual({ text: "Summarise.", mentions: { scope: "note", folder: null, notes: [] }, error: null });
		const linked = extractConsoleMentions("Compare with @[[Vendors]]?");
		expect(linked.text).toBe("Compare with?");
		expect(linked.mentions.notes).toEqual(["Vendors"]);
		expect(extractConsoleMentions("Use @folder:Projects/Q3, please").mentions.folder).toBe("Projects/Q3");
	});

	test("spacing is kept everywhere except where a mention was removed", () => {
		const code = "Explain this code @selection\n    if x:\n        return  1\n| a  | b |";
		expect(extractConsoleMentions(code).text).toBe("Explain this code\n    if x:\n        return  1\n| a  | b |");
		expect(extractConsoleMentions("    indented question").text).toBe("indented question");
	});

	test("a note mention drops its alias, heading or block reference", () => {
		expect(extractConsoleMentions("see @[[Vendors#Pricing|prices]] and @[[Team^abc]]").mentions.notes).toEqual(["Vendors", "Team"]);
	});

	test("@selection and @note together are an error", () => {
		expect(extractConsoleMentions("@selection @note rewrite").error).toBe("Use either @selection or @note, not both.");
	});
});

describe("parseConsoleInput", () => {
	test("plain text is a question", () => {
		expect(parseConsoleInput("What are the risks?", commands)).toEqual({
			kind: "ask",
			question: "What are the risks?",
			outputMode: null,
			mentions: { scope: "auto", folder: null, notes: [] },
			literal: false
		});
	});

	test("a // line is a literal question, never a command", () => {
		expect(parseConsoleInput("//image a fox", commands)).toMatchObject({ kind: "ask", question: "/image a fox", literal: true });
	});

	test("an ambiguous prefix lists the matching commands", () => {
		const action = parseConsoleInput("/p", commands);
		expect(action.kind).toBe("error");
		if (action.kind === "error") {
			expect(action.message).toContain("/p could mean");
			expect(action.message).toContain("/polish");
		}
	});

	test("a workflow command keeps extra instructions and mentions", () => {
		const action = parseConsoleInput("/polish keep it short @selection", commands);
		expect(action).toMatchObject({ kind: "workflow", workflowId: "rewrite-polish", extra: "keep it short", mentions: { scope: "selection" } });
	});

	test("a unique prefix runs the command", () => {
		expect(parseConsoleInput("/pol", commands)).toMatchObject({ kind: "workflow", workflowId: "rewrite-polish" });
	});

	test("mode commands switch mode alone and ask once with text", () => {
		expect(parseConsoleInput("/apply", commands)).toEqual({ kind: "mode", mode: "apply" });
		expect(parseConsoleInput("/note list the risks", commands)).toMatchObject({ kind: "ask", question: "list the risks", outputMode: "note" });
	});

	test("image, effort and layout commands validate their argument", () => {
		expect(parseConsoleInput("/image a lighthouse", commands)).toMatchObject({ kind: "image", prompt: "a lighthouse" });
		expect(parseConsoleInput("/image", commands).kind).toBe("error");
		expect(parseConsoleInput("/effort high", commands)).toEqual({ kind: "effort", effort: "high" });
		expect(parseConsoleInput("/effort", commands)).toEqual({ kind: "effort", effort: null });
		expect(parseConsoleInput("/effort extreme", commands).kind).toBe("error");
		expect(parseConsoleInput("/layout standard", commands)).toEqual({ kind: "layout", layout: "compact" });
		expect(parseConsoleInput("/layout tiny", commands).kind).toBe("error");
		expect(parseConsoleInput("/layout constructor", commands).kind).toBe("error");
		expect(resolveLayoutName("toString")).toBeNull();
		expect(resolveLayoutName(" Console ")).toBe("console");
	});

	test("unknown commands explain how to send text that starts with a slash", () => {
		const action = parseConsoleInput("/Users/me/notes", commands);
		expect(action.kind).toBe("error");
		expect(parseConsoleInput("//Users/me/notes is my path", commands)).toMatchObject({ kind: "ask", question: "/Users/me/notes is my path" });
	});

	test("empty input and mention-only input are errors", () => {
		expect(parseConsoleInput("   ", commands).kind).toBe("error");
		expect(parseConsoleInput("@selection", commands)).toEqual({ kind: "error", message: "Add a question after the mentions." });
	});

	test("utility commands", () => {
		expect(parseConsoleInput("/help", commands)).toEqual({ kind: "help" });
		expect(parseConsoleInput("/?", commands)).toEqual({ kind: "help" });
		expect(parseConsoleInput("/clear", commands)).toEqual({ kind: "clear" });
		expect(parseConsoleInput("/context @note", commands)).toMatchObject({ kind: "context", mentions: { scope: "note" } });
		expect(parseConsoleInput("/inspect why?", commands)).toMatchObject({ kind: "inspect", question: "why?" });
		expect(parseConsoleInput("/history", commands)).toEqual({ kind: "history" });
	});
});

describe("getConsoleCompletions", () => {
	test("suggests commands for a slash prefix, best matches first", () => {
		const result = getConsoleCompletions("/po", 3, commands);
		expect(result.from).toBe(0);
		expect(result.items[0].insertText).toBe("/polish ");
		expect(result.items.length).toBeLessThanOrEqual(8);
	});

	test("suggests mentions for the token under the cursor", () => {
		const input = "rewrite this @se";
		const result = getConsoleCompletions(input, input.length, commands);
		expect(result.from).toBe(input.indexOf("@se"));
		expect(result.items.map((item) => item.label)).toEqual(["@selection"]);
	});

	test("no suggestions inside ordinary text", () => {
		expect(getConsoleCompletions("what about /polish", 18, commands).items).toHaveLength(0);
		expect(getConsoleCompletions("/polish now", 11, commands).items).toHaveLength(0);
	});
});

describe("help and status", () => {
	test("help lists built-in commands, workflows and mentions", () => {
		const help = formatConsoleHelp(commands);
		expect(help).toContain("/polish");
		expect(help).toContain("/layout");
		expect(help).toContain("@[[Note]]");
	});

	test("status shows budget percentage when a daily budget is set", () => {
		const segments = formatConsoleStatus({ mode: "apply", providerName: "OpenAI", model: "gpt-5.5", effort: "medium", dayUsedTokens: 18000, dayBudgetTokens: 100000 });
		expect(segments.map((segment) => segment.text)).toEqual(["APPLY", "gpt-5.5", "medium", "day 18%"]);
	});

	test("status shows today's tokens without a budget and hides effort when unsupported", () => {
		const segments = formatConsoleStatus({ mode: "chat", providerName: "Anthropic", model: "claude-sonnet-5-5", effort: null, dayUsedTokens: 3140, dayBudgetTokens: 0 });
		expect(segments.map((segment) => segment.text)).toEqual(["CHAT", "claude-sonnet-5-5", "today 3.1k"]);
	});
});
