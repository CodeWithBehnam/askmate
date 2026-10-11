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
		expect(result.mentions).toEqual({ scope: "selection", folder: "Projects/Q3 Plans", notes: ["Vendors"], vault: [] });
	});

	test("@folder alone means the folder from settings", () => {
		expect(extractConsoleMentions("summarise @folder").mentions.folder).toBe("");
	});

	test("email addresses and unknown @words are left alone", () => {
		const result = extractConsoleMentions("email me@example.com about @weekly");
		expect(result.text).toBe("email me@example.com about @weekly");
		expect(result.mentions).toEqual({ scope: "auto", folder: null, notes: [], vault: [] });
	});

	test("mentions may be followed by punctuation", () => {
		expect(extractConsoleMentions("Summarise @note.")).toEqual({ text: "Summarise.", mentions: { scope: "note", folder: null, notes: [], vault: [] }, error: null });
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

	test("a keyword followed by a file extension is not a mention", () => {
		const result = extractConsoleMentions("Is @note.md fine?");
		expect(result.text).toBe("Is @note.md fine?");
		expect(result.mentions.scope).toBe("auto");
		expect(extractConsoleMentions("Summarise @note. Then stop").mentions.scope).toBe("note");
	});

	test("a bare folder name stops at a comma or semicolon", () => {
		const result = extractConsoleMentions("@folder:Projects,@note summarise");
		expect(result.mentions.folder).toBe("Projects");
		expect(extractConsoleMentions("@folder:Projects; summarise").mentions.folder).toBe("Projects");
	});

	test("an empty argument after a colon consumes the colon", () => {
		const result = extractConsoleMentions("@folder: summarise");
		expect(result.mentions.folder).toBe("");
		expect(result.text).toBe("summarise");
	});

	test("reads @links, @backlinks, @tag and @recent", () => {
		const result = extractConsoleMentions("Compare @links @backlinks @tag:#Project/Alpha @recent:7 please");
		expect(result.error).toBeNull();
		expect(result.text).toBe("Compare please");
		expect(result.mentions.vault).toEqual([
			{ kind: "links" },
			{ kind: "backlinks" },
			{ kind: "tag", tag: "project/alpha" },
			{ kind: "recent", count: 7 }
		]);
	});

	test("vault mentions work next to punctuation and are deduplicated", () => {
		const result = extractConsoleMentions("Compare with @backlinks. Also @backlinks, @tag:todo!");
		expect(result.mentions.vault).toEqual([{ kind: "backlinks" }, { kind: "tag", tag: "todo" }]);
		expect(result.text).toBe("Compare with. Also,!");
	});

	test("@recent defaults to 5 and clamps to 20", () => {
		expect(extractConsoleMentions("x @recent").mentions.vault).toEqual([{ kind: "recent", count: 5 }]);
		expect(extractConsoleMentions("x @recent:99").mentions.vault).toEqual([{ kind: "recent", count: 20 }]);
		expect(extractConsoleMentions("x @recent:5.").mentions.vault).toEqual([{ kind: "recent", count: 5 }]);
	});

	test("malformed vault mentions are errors", () => {
		expect(extractConsoleMentions("x @tag:").error).toContain("@tag needs a tag");
		expect(extractConsoleMentions("x @tag").error).toContain("@tag needs a tag");
		expect(extractConsoleMentions("x @tag:#").error).toContain("@tag needs a tag");
		expect(extractConsoleMentions("x @recent:0").error).toContain("@recent:0");
		expect(extractConsoleMentions("x @recent:abc").error).toContain("@recent:abc");
		expect(extractConsoleMentions("x @recent:-3").error).toContain("@recent:-3");
	});

	test("@links and @backlinks with an argument stay as typed", () => {
		expect(extractConsoleMentions("see @links:foo and @backlinks:bar").text).toBe("see @links:foo and @backlinks:bar");
		expect(extractConsoleMentions("email a@links.com").mentions.vault).toEqual([]);
	});
});

describe("parseConsoleInput", () => {
	test("plain text is a question", () => {
		expect(parseConsoleInput("What are the risks?", commands)).toEqual({
			kind: "ask",
			question: "What are the risks?",
			outputMode: null,
			mentions: { scope: "auto", folder: null, notes: [], vault: [] },
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

	test("export and thread commands", () => {
		expect(parseConsoleInput("/export", commands)).toEqual({ kind: "export", title: "" });
		expect(parseConsoleInput("/export Budget review: Q3", commands)).toEqual({ kind: "export", title: "Budget review: Q3" });
		expect(parseConsoleInput("/new", commands)).toEqual({ kind: "newThread" });
		expect(parseConsoleInput("/threads", commands)).toEqual({ kind: "threads" });
		expect(parseConsoleInput("/rename  Weekly notes ", commands)).toEqual({ kind: "renameThread", title: "Weekly notes" });
		expect(parseConsoleInput("/delete-thread", commands)).toEqual({ kind: "deleteThread" });
	});

	test("/rename without a title is an error", () => {
		expect(parseConsoleInput("/rename", commands).kind).toBe("error");
	});

	test("/new with text is an error instead of silently dropping the question", () => {
		const result = parseConsoleInput("/new list the risks", commands);
		expect(result.kind).toBe("error");
		expect(result.kind === "error" ? result.message : "").toContain("/note");
	});

	test("thread commands do not take over the /s prefix used by workflows", () => {
		expect(parseConsoleInput("/switch", commands).kind).toBe("error");
	});

	test("/new-note still reaches the note command", () => {
		expect(parseConsoleInput("/new-note", commands)).toEqual({ kind: "mode", mode: "note" });
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

	test("the replaced range covers the rest of the token after the cursor", () => {
		const command = getConsoleCompletions("/help", 3, commands);
		expect(command).toMatchObject({ from: 0, to: 5 });
		const input = "hello @note more";
		const mention = getConsoleCompletions(input, input.indexOf("note") + 2, commands);
		expect(mention).toMatchObject({ from: 6, to: 11 });
	});

	test("offers the vault mentions", () => {
		const labels = (input: string): string[] => getConsoleCompletions(input, input.length, commands).items.map((item) => item.label);
		expect(labels("@lin")).toEqual(["@links"]);
		expect(labels("@back")).toEqual(["@backlinks"]);
		expect(labels("@rec")).toEqual(["@recent"]);
		expect(labels("@ta")).toEqual(["@tag:"]);
	});

	test("suggests existing vault tags after @tag:", () => {
		const tags = { models: [], providers: [], vaultTags: ["#project", "#project/alpha", "#Reading", "#todo"] };
		const result = getConsoleCompletions("see @tag:pro", 12, commands, tags);
		expect(result.from).toBe(4);
		expect(result.items.map((item) => item.insertText)).toEqual(["@tag:project ", "@tag:project/alpha "]);
		expect(getConsoleCompletions("@tag:", 5, commands, tags).items).toHaveLength(4);
		expect(getConsoleCompletions("@tag:#read", 10, commands, tags).items.map((item) => item.label)).toEqual(["@tag:Reading"]);
		expect(getConsoleCompletions("@tag:zzz", 8, commands, tags).items).toHaveLength(0);
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

describe("/model and /provider", () => {
	const source = {
		models: ["gpt-5.5", "gpt-5.5-mini", "gpt-image-2"],
		providers: [{ id: "openai", label: "OpenAI" }, { id: "anthropic", label: "Anthropic Claude" }]
	};

	test("parse with and without an argument", () => {
		expect(parseConsoleInput("/model", commands)).toEqual({ kind: "model", query: "" });
		expect(parseConsoleInput("/model gpt-5.5-mini", commands)).toEqual({ kind: "model", query: "gpt-5.5-mini" });
		expect(parseConsoleInput("/models custom-id!", commands)).toEqual({ kind: "model", query: "custom-id!" });
		expect(parseConsoleInput("/provider anthropic", commands)).toEqual({ kind: "provider", query: "anthropic" });
		expect(parseConsoleInput("/provider", commands)).toEqual({ kind: "provider", query: "" });
	});

	test("the command names are suggested", () => {
		const labels = getConsoleCompletions("/mod", 4, commands).items.map((item) => item.label);
		expect(labels[0]).toBe("/model [id]");
	});

	test("model arguments are completed from the available models", () => {
		const result = getConsoleCompletions("/model gpt-5", 12, commands, source);
		expect(result.from).toBe(7);
		expect(result.to).toBe(12);
		expect(result.items.map((item) => item.insertText)).toEqual(["gpt-5.5", "gpt-5.5-mini"]);
	});

	test("provider arguments match ids and labels", () => {
		expect(getConsoleCompletions("/provider claude", 16, commands, source).items.map((item) => item.insertText)).toEqual(["anthropic"]);
	});

	test("an empty argument offers nothing so Enter still lists models", () => {
		expect(getConsoleCompletions("/model ", 7, commands, source).items).toEqual([]);
	});

	test("other commands do not complete arguments", () => {
		expect(getConsoleCompletions("/effort hi", 10, commands, source).items).toEqual([]);
	});
});
