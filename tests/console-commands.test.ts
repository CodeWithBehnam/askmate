import { describe, expect, test } from "bun:test";
import { MAX_RECENT_COUNT } from "../src/context/vaultMentions";
import {
	buildConsoleCommands,
	classifyConsoleAction,
	extractConsoleMentions,
	resolveLayoutName,
	formatConsoleHelp,
	formatConsoleStatus,
	getConsoleCompletions,
	isRequestAction,
	parseConsoleInput,
	slugifyCommandName,
	type ConsoleAction,
	type ConsoleMentions
} from "../src/ui/sidebar/consoleCommands";
import { WORKFLOWS } from "../src/workflows/builtInWorkflows";
import type { Workflow } from "../src/shared/types";

const commands = buildConsoleCommands(WORKFLOWS);
const NO_MENTIONS: ConsoleMentions = { scope: "auto", folder: null, notes: [], vault: [], skills: [] };

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
		expect(result.mentions).toEqual({ scope: "selection", folder: "Projects/Q3 Plans", notes: ["Vendors"], vault: [], skills: [] });
	});

	test("@folder alone means the folder from settings", () => {
		expect(extractConsoleMentions("summarise @folder").mentions.folder).toBe("");
	});

	test("email addresses and unknown @words are left alone", () => {
		const result = extractConsoleMentions("email me@example.com about @weekly");
		expect(result.text).toBe("email me@example.com about @weekly");
		expect(result.mentions).toEqual(NO_MENTIONS);
	});

	test("mentions may be followed by punctuation", () => {
		expect(extractConsoleMentions("Summarise @note.")).toEqual({ text: "Summarise.", mentions: { ...NO_MENTIONS, scope: "note" }, error: null, hints: [] });
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

	test("@recent defaults to 5 and clamps to the number of notes one mention can attach (CTX-02)", () => {
		expect(extractConsoleMentions("x @recent").mentions.vault).toEqual([{ kind: "recent", count: 5 }]);
		expect(extractConsoleMentions("x @recent:99").mentions.vault).toEqual([{ kind: "recent", count: MAX_RECENT_COUNT }]);
		expect(extractConsoleMentions("x @recent:0").error).toContain(`from 1 to ${MAX_RECENT_COUNT}`);
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
			mentions: NO_MENTIONS,
			literal: false,
			hints: []
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

	test("help says which keys belong to the Console layout, because the other layouts have the commands but not those keys", () => {
		const keys = formatConsoleHelp(commands).split("\n").filter((line) => /Tab|Esc|recalls/.test(line));
		expect(keys).toEqual([
			"  Tab or Enter accepts a suggestion, and Esc closes the suggestions.",
			"  In the Console layout, ↑ recalls earlier input and Esc also stops a request."
		]);
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

describe("escapes, code and prose (CTX-05)", () => {
	test("a backslash escapes a mention and is not sent", () => {
		const tag = extractConsoleMentions("What does \\@tag do in Java?");
		expect(tag).toEqual({ text: "What does @tag do in Java?", mentions: NO_MENTIONS, error: null, hints: [] });
		expect(extractConsoleMentions("Explain the \\@recent decorator").mentions.vault).toEqual([]);
		expect(extractConsoleMentions("Explain the \\@recent decorator").text).toBe("Explain the @recent decorator");
		expect(extractConsoleMentions("\\@[[Vendors]] is a link").text).toBe("@[[Vendors]] is a link");
		expect(extractConsoleMentions("\\@note").mentions.scope).toBe("auto");
	});

	test("a backslash before something that is not a mention is left alone", () => {
		expect(extractConsoleMentions("path C:\\@home and a\\@links.com").text).toBe("path C:\\@home and a\\@links.com");
	});

	test("mentions inside fenced code are text", () => {
		const input = "What is wrong here?\n```ts\n@tag foo\n@recent\n```";
		const result = extractConsoleMentions(input);
		expect(result.error).toBeNull();
		expect(result.text).toBe(input);
		expect(result.mentions).toEqual(NO_MENTIONS);
		expect(extractConsoleMentions("~~~\n@note\n~~~\nExplain").mentions.scope).toBe("auto");
	});

	test("an unclosed fence hides everything after it", () => {
		const result = extractConsoleMentions("Explain\n```\n@tag foo");
		expect(result.error).toBeNull();
		expect(result.text).toBe("Explain\n```\n@tag foo");
	});

	test("mentions inside inline code are text, and mentions outside it still work", () => {
		const result = extractConsoleMentions("Why does `@tag` fail? @note");
		expect(result.mentions.scope).toBe("note");
		expect(result.text).toBe("Why does `@tag` fail?");
		expect(extractConsoleMentions("Use ``@recent `x` `` here").mentions.vault).toEqual([]);
	});

	test("unmatched backticks do not hide a later mention", () => {
		expect(extractConsoleMentions("a ` b @note").mentions.scope).toBe("note");
	});

	test("a bare @tag in the middle of a sentence is text with a hint, not an error", () => {
		const result = extractConsoleMentions("What does the @tag annotation do in Java?");
		expect(result.error).toBeNull();
		expect(result.text).toBe("What does the @tag annotation do in Java?");
		expect(result.mentions.vault).toEqual([]);
		expect(result.hints).toHaveLength(1);
		expect(result.hints[0]).toContain("@tag:name");
	});

	test("a bare @tag at the end is still an error, because the user probably forgot the tag", () => {
		expect(extractConsoleMentions("x @tag").error).toContain("@tag needs a tag");
		expect(extractConsoleMentions("x @tag.").error).toContain("@tag needs a tag");
		expect(extractConsoleMentions("x @tag:").error).toContain("@tag needs a tag");
	});

	test("a keyword used mid-sentence is still read as a mention, with a hint on how to send the word", () => {
		const result = extractConsoleMentions("Explain the @recent decorator in my code");
		expect(result.mentions.vault).toEqual([{ kind: "recent", count: 5 }]);
		expect(result.hints).toHaveLength(1);
		expect(result.hints[0]).toContain("\\@recent");
	});

	test("mentions at the start or the end, or next to each other, give no hint", () => {
		expect(extractConsoleMentions("@recent summarise").hints).toEqual([]);
		expect(extractConsoleMentions("Summarise @note.").hints).toEqual([]);
		expect(extractConsoleMentions("fix tone @selection @folder:Projects").hints).toEqual([]);
		expect(extractConsoleMentions("Compare @links @backlinks").hints).toEqual([]);
	});

	test("the // prefix is checked before mentions, so a literal line never errors", () => {
		const bare = parseConsoleInput("//what does @tag mean", commands);
		expect(bare).toMatchObject({ kind: "ask", question: "/what does @tag mean", literal: true, mentions: NO_MENTIONS });
		const ending = parseConsoleInput("//the doxygen @tag", commands);
		expect(ending).toMatchObject({ kind: "ask", question: "/the doxygen @tag", literal: true });
		const malformed = parseConsoleInput("//explain @recent:abc", commands);
		expect(malformed).toMatchObject({ kind: "ask", question: "/explain @recent:abc", literal: true });
	});

	test("a literal line still honours well-formed mentions and sends no hints", () => {
		const action = parseConsoleInput("//Users/me/notes explain @note", commands);
		expect(action).toMatchObject({ kind: "ask", question: "/Users/me/notes explain", literal: true, mentions: { scope: "note" }, hints: [] });
	});
});

describe("@skill mentions", () => {
	test("reads skill names, lower-cased and de-duplicated", () => {
		const result = extractConsoleMentions("Draw this @skill:Mermaid-Diagrams and @skill:mermaid-diagrams @skill:summarise");
		expect(result.error).toBeNull();
		expect(result.mentions.skills).toEqual(["mermaid-diagrams", "summarise"]);
		expect(result.text).toBe("Draw this and");
	});

	test("a quoted name may contain spaces", () => {
		expect(extractConsoleMentions("Plan @skill:\"Release Notes\" please").mentions.skills).toEqual(["release notes"]);
	});

	test("a bare @skill at the end needs a name, and mid-sentence it is text", () => {
		expect(extractConsoleMentions("use @skill").error).toContain("@skill needs a skill name");
		expect(extractConsoleMentions("use @skill:").error).toContain("@skill needs a skill name");
		const prose = extractConsoleMentions("the @skill decorator is useful");
		expect(prose.error).toBeNull();
		expect(prose.text).toBe("the @skill decorator is useful");
		expect(prose.hints).toHaveLength(1);
	});

	test("an escaped @skill is text", () => {
		const result = extractConsoleMentions("see \\@skill:foo");
		expect(result.mentions.skills).toEqual([]);
		expect(result.text).toBe("see @skill:foo");
	});

	test("travels with the question", () => {
		expect(parseConsoleInput("Draw this @skill:mermaid-diagrams", commands)).toMatchObject({
			kind: "ask",
			question: "Draw this",
			mentions: { skills: ["mermaid-diagrams"] }
		});
	});

	test("is suggested while typing, with the skill description", () => {
		const source = { models: [], providers: [], skills: [{ name: "mermaid-diagrams", description: "Draw diagrams" }, { name: "summarise", description: "Short summaries" }] };
		const input = "use @skill:mer";
		const result = getConsoleCompletions(input, input.length, commands, source);
		expect(result.from).toBe(4);
		expect(result.items).toEqual([{ label: "@skill:mermaid-diagrams", insertText: "@skill:mermaid-diagrams ", detail: "Draw diagrams", group: "Skills" }]);
		expect(getConsoleCompletions("@ski", 4, commands, source).items.map((item) => item.label)).toEqual(["@skill:"]);
		expect(getConsoleCompletions("@skill:", 7, commands, source).items).toHaveLength(2);
	});
});

describe("new commands", () => {
	test("setup and welcome", () => {
		expect(parseConsoleInput("/setup", commands)).toEqual({ kind: "setup" });
		expect(parseConsoleInput("/connect", commands)).toEqual({ kind: "setup" });
		expect(parseConsoleInput("/welcome", commands)).toEqual({ kind: "welcome" });
	});

	test("skills lists, skill runs one", () => {
		expect(parseConsoleInput("/skills", commands)).toEqual({ kind: "skills" });
		expect(parseConsoleInput("/skill", commands)).toEqual({ kind: "skills" });
		expect(parseConsoleInput("/skill mermaid-diagrams draw the flow @note", commands)).toEqual({
			kind: "skill",
			name: "mermaid-diagrams",
			question: "draw the flow",
			mentions: { ...NO_MENTIONS, scope: "note" }
		});
		expect(parseConsoleInput("/skill mermaid-diagrams", commands)).toMatchObject({ kind: "skill", name: "mermaid-diagrams", question: "" });
		expect(parseConsoleInput("/skill \"Release Notes\" go", commands)).toMatchObject({ kind: "skill", name: "release notes", question: "go" });
	});

	test("diagram takes an optional description", () => {
		expect(parseConsoleInput("/diagram", commands)).toEqual({ kind: "diagram", prompt: "", mentions: NO_MENTIONS });
		expect(parseConsoleInput("/diagram the sign-up flow @selection", commands)).toMatchObject({ kind: "diagram", prompt: "the sign-up flow", mentions: { scope: "selection" } });
	});

	test("the Diagram workflow keeps a command of its own", () => {
		const workflowCommand = commands.find((command) => command.kind === "workflow" && command.workflowId === "mermaid-diagram");
		expect(workflowCommand).toBeDefined();
		expect(workflowCommand?.name).not.toBe("diagram");
	});

	test("mcp and test", () => {
		expect(parseConsoleInput("/mcp", commands)).toEqual({ kind: "mcp" });
		expect(parseConsoleInput("/test", commands)).toEqual({ kind: "test" });
	});

	test("images shows, enables or disables previews", () => {
		expect(parseConsoleInput("/images", commands)).toEqual({ kind: "images", setting: null });
		expect(parseConsoleInput("/images on", commands)).toEqual({ kind: "images", setting: "on" });
		expect(parseConsoleInput("/images OFF", commands)).toEqual({ kind: "images", setting: "off" });
		const bad = parseConsoleInput("/images maybe", commands);
		expect(bad).toEqual({ kind: "error", message: "Use /images on or /images off." });
	});

	test("commands that take no text say so instead of dropping it", () => {
		for (const input of ["/setup now", "/welcome x", "/skills mermaid", "/mcp list", "/test fast", "/help topics", "/history all", "/clear everything", "/threads old", "/delete-thread x", "/context why?"]) {
			const action = parseConsoleInput(input, commands);
			expect(action.kind).toBe("error");
			expect(action.kind === "error" ? action.message : "").toContain("takes no text");
		}
	});

	test("destructive commands run only on an exact name (UX-09)", () => {
		expect(parseConsoleInput("/clear", commands)).toEqual({ kind: "clear" });
		expect(parseConsoleInput("/cls", commands)).toEqual({ kind: "clear" });
		const prefix = parseConsoleInput("/cl", commands);
		expect(prefix.kind).toBe("error");
		expect(prefix.kind === "error" ? prefix.message : "").toContain("/clear");
		expect(prefix.kind === "error" ? prefix.message : "").toContain("whole command name");
		expect(parseConsoleInput("/delete", commands).kind).toBe("error");
		expect(parseConsoleInput("/delete-thread", commands)).toEqual({ kind: "deleteThread" });
	});

	test("an ambiguous prefix puts name matches first and shows the alias that matched", () => {
		const action = parseConsoleInput("/p", commands);
		const message = action.kind === "error" ? action.message : "";
		expect(message).toContain("/inspect (prompt)");
		expect(message.indexOf("/polish")).toBeLessThan(message.indexOf("/inspect (prompt)"));
	});
});

describe("request actions", () => {
	const sample: Record<ConsoleAction["kind"], ConsoleAction> = {
		ask: { kind: "ask", question: "q", outputMode: null, mentions: NO_MENTIONS, literal: false, hints: [] },
		image: { kind: "image", prompt: "p", mentions: NO_MENTIONS },
		workflow: { kind: "workflow", workflowId: "w", extra: "", mentions: NO_MENTIONS },
		diagram: { kind: "diagram", prompt: "", mentions: NO_MENTIONS },
		skill: { kind: "skill", name: "s", question: "q", mentions: NO_MENTIONS },
		mode: { kind: "mode", mode: "chat" },
		effort: { kind: "effort", effort: null },
		layout: { kind: "layout", layout: "console" },
		clear: { kind: "clear" },
		help: { kind: "help" },
		context: { kind: "context", mentions: NO_MENTIONS },
		inspect: { kind: "inspect", question: "", mentions: NO_MENTIONS },
		history: { kind: "history" },
		model: { kind: "model", query: "" },
		provider: { kind: "provider", query: "" },
		export: { kind: "export", title: "" },
		newThread: { kind: "newThread" },
		threads: { kind: "threads" },
		renameThread: { kind: "renameThread", title: "t" },
		deleteThread: { kind: "deleteThread" },
		setup: { kind: "setup" },
		welcome: { kind: "welcome" },
		skills: { kind: "skills" },
		mcp: { kind: "mcp" },
		test: { kind: "test" },
		images: { kind: "images", setting: null },
		error: { kind: "error", message: "m" }
	};

	test("only actions that send a request count as request actions", () => {
		const requests = Object.values(sample).filter(isRequestAction).map((action) => action.kind).sort();
		expect(requests).toEqual(["ask", "diagram", "image", "skill", "workflow"]);
	});

	test("a /skill with no question only selects the skill", () => {
		expect(isRequestAction({ kind: "skill", name: "s", question: "", mentions: NO_MENTIONS })).toBe(false);
	});

	test("every action kind is classified", () => {
		for (const action of Object.values(sample)) {
			expect(["request", "local", "error"]).toContain(classifyConsoleAction(action));
		}
		expect(classifyConsoleAction(sample.error)).toBe("error");
		expect(classifyConsoleAction(sample.diagram)).toBe("request");
		expect(classifyConsoleAction(sample.help)).toBe("local");
	});
});

describe("slash menu (UX-21, CTX-06)", () => {
	const complete = (input: string, source?: Parameters<typeof getConsoleCompletions>[3]) => getConsoleCompletions(input, input.length, commands, source);

	test("an empty query lists workflows first, then commands, and counts what is hidden", () => {
		const result = complete("/");
		const groups = result.items.map((item) => item.group);
		expect(groups.slice(0, 6).every((group) => group === "Workflows")).toBe(true);
		expect(groups.slice(6).every((group) => group === "Commands")).toBe(true);
		expect(groups.includes("Commands")).toBe(true);
		expect(result.items[0]?.insertText).toBe(`/${commands.find((command) => command.kind === "workflow")?.name} `);
		expect(result.more).toBe(commands.length - result.items.length);
		expect(result.more).toBeGreaterThan(0);
	});

	test("a query keeps best-match order and reports how many more match", () => {
		const result = complete("/p");
		expect(result.items.length).toBeLessThanOrEqual(8);
		expect(result.items.length + result.more).toBeGreaterThan(5);
		expect(complete("/polish").more).toBe(0);
	});

	test("a command is also found by its summary", () => {
		const withReview = buildConsoleCommands([...WORKFLOWS, custom("custom-weekly", "WR", "Weekly review")]);
		const result = getConsoleCompletions("/review", 7, withReview);
		expect(result.items.map((item) => item.insertText)).toContain("/wr ");
		const exact = getConsoleCompletions("/wr", 3, withReview);
		expect(exact.items[0]?.insertText).toBe("/wr ");
	});

	test("non-Latin workflow names get commands made of their own letters", () => {
		expect(slugifyCommandName("خلاصه")).toBe("خلاصه");
		expect(slugifyCommandName("要約")).toBe("要約");
		expect(slugifyCommandName("Резюме")).toBe("резюме");
		expect(slugifyCommandName("हिन्दी भाषा")).toBe("हिन्दी-भाषा");
		expect(slugifyCommandName("Résumé Builder!")).toBe("resume-builder");
		const built = buildConsoleCommands([custom("custom-1736000000-abcde", "خلاصه"), custom("custom-1736000001-fghij", "要約")]);
		const names = built.filter((command) => command.kind === "workflow").map((command) => command.name);
		expect(names).toEqual(["خلاصه", "要約"]);
		expect(getConsoleCompletions("/خلا", 4, built).items[0]?.insertText).toBe("/خلاصه ");
		expect(parseConsoleInput("/خلاصه کوتاه", built)).toMatchObject({ kind: "workflow", workflowId: "custom-1736000000-abcde", extra: "کوتاه" });
	});

	// Names are written as escapes so the source file's own normalisation can never hide a mismatch. Each of these
	// decomposes under NFKD (hamza and madda alef, Hangul syllables, kana with a voiced mark), and keyboards and IMEs type NFC.
	const COMPOSED_NAMES: readonly [label: string, name: string][] = [
		["Persian madda alef", "آموزش"],
		["Arabic hamza alef", "أخبار"],
		["Korean", "요약"],
		["hiragana with dakuten", "ありがとう"],
		["katakana with dakuten", "ガイド"],
		["Devanagari with nukta", "क़ानून"]
	];

	test.each(COMPOSED_NAMES)("%s: the slug is NFC, so the typed name equals the stored name", (_label, name) => {
		expect(slugifyCommandName(name)).toBe(name.normalize("NFC"));
		const built = buildConsoleCommands([custom("custom-1736000000-abcde", name)]);
		const command = built.find((candidate) => candidate.kind === "workflow");
		expect(command?.name).toBe(name.normalize("NFC"));
		expect(parseConsoleInput(`/${name} extra`, built)).toMatchObject({ kind: "workflow", workflowId: "custom-1736000000-abcde", extra: "extra" });
	});

	test.each(COMPOSED_NAMES)("%s: a decomposed or composition-excluded spelling also runs and completes the command", (_label, name) => {
		// Guards the fixture: if an editor normalised the literal, the forms would collapse and the test would prove nothing.
		expect(new Set([name, name.normalize("NFC"), name.normalize("NFD")]).size).toBeGreaterThan(1);
		const built = buildConsoleCommands([custom("custom-1736000000-abcde", name)]);
		const spellings = [name.normalize("NFC"), name.normalize("NFD"), name.normalize("NFKD")];
		for (const spelling of spellings) {
			expect(parseConsoleInput(`/${spelling}`, built)).toMatchObject({ kind: "workflow", workflowId: "custom-1736000000-abcde" });
			const completion = getConsoleCompletions(`/${spelling}`, spelling.length + 1, built);
			expect(completion.items[0]?.insertText).toBe(`/${name.normalize("NFC")} `);
		}
	});

	test("completions find a command by the start of its composed name", () => {
		const korean = "요약";
		const built = buildConsoleCommands([custom("custom-1736000000-abcde", korean, "Korean summary")]);
		expect(getConsoleCompletions("/요", 2, built).items[0]?.insertText).toBe(`/${korean} `);
	});

	test("the summary is matched whatever form it was saved in", () => {
		const built = buildConsoleCommands([custom("custom-1736000000-abcde", "WR", "要約とがいど".normalize("NFD"))]);
		const typed = "がいど";
		expect(getConsoleCompletions(`/${typed}`, typed.length + 1, built).items.map((item) => item.insertText)).toContain("/wr ");
	});

	test("a Persian name written with a zero-width non-joiner still runs when typed without it", () => {
		const withJoiner = "می‌خواهم";
		const without = "میخواهم";
		const built = buildConsoleCommands([custom("custom-1736000000-abcde", withJoiner)]);
		expect(built.find((command) => command.kind === "workflow")?.name).toBe(without);
		expect(parseConsoleInput(`/${withJoiner}`, built)).toMatchObject({ kind: "workflow" });
		expect(parseConsoleInput(`/${without}`, built)).toMatchObject({ kind: "workflow" });
	});

	test("Latin names are folded the same way when typed with accents or capitals", () => {
		const built = buildConsoleCommands([custom("custom-1736000000-abcde", "Résumé")]);
		expect(built.find((command) => command.kind === "workflow")?.name).toBe("resume");
		expect(parseConsoleInput("/RÉSUMÉ", built)).toMatchObject({ kind: "workflow" });
		expect(parseConsoleInput("/résumé", built)).toMatchObject({ kind: "workflow" });
	});

	test("a name with no letters or digits falls back to custom-1, custom-2", () => {
		const built = buildConsoleCommands([custom("custom-a", "🔥"), custom("custom-b", "✨"), custom("custom-c", "🌟")]);
		expect(built.filter((command) => command.kind === "workflow").map((command) => command.name)).toEqual(["custom-1", "custom-2", "custom-3"]);
	});

	test("a clash on every slug still yields a command instead of dropping the workflow", () => {
		const built = buildConsoleCommands([custom("polish", "Polish"), custom("polish", "Polish")]);
		const names = built.filter((command) => command.kind === "workflow").map((command) => command.name);
		expect(names).toHaveLength(2);
		expect(new Set(names).size).toBe(2);
	});
});

describe("help", () => {
	test("starts with a short Start here section and shows argument hints and aliases", () => {
		const help = formatConsoleHelp(commands);
		expect(help.split("\n")[0]).toBe("Start here");
		expect(help).toContain("/skill <name> [question]");
		expect(help).toContain("(also /ctx)");
		expect(help).toContain("@skill:name");
		expect(help).toContain(`up to ${MAX_RECENT_COUNT}`);
		expect(help).not.toContain("up to 20");
	});

	test("the @recent completion promises no more than the cap", () => {
		const detail = getConsoleCompletions("@rec", 4, commands).items[0]?.detail ?? "";
		expect(detail).toContain(`@recent:${MAX_RECENT_COUNT}`);
	});
});
