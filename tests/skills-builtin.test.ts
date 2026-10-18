import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	BUILT_IN_SKILL_DEFINITIONS,
	BUILT_IN_SKILL_NAMES,
	EXAMPLE_SKILL_TEMPLATES,
	MAX_BUILT_IN_BODY,
	MAX_DESCRIPTION,
	MAX_TRIGGERS,
	MAX_TRIGGER_LENGTH,
	MAX_VAULT_BODY,
	MERMAID_DIAGRAMS_SKILL,
	builtInSkillId,
	createSkillScaffold,
	hashSkillText,
	lintSkillText,
	loadBuiltInSkills,
	parseSkillFile,
	renderBuiltInSkill,
	sanitiseSkillText,
	slugifySkillName,
	type Skill
} from "../src/skills";
import { TABLE_CELL_RULE } from "../src/workflows/promptRules";

const parseYaml = (text: string): unknown => Bun.YAML.parse(text);
const builtIns = await loadBuiltInSkills(parseYaml, (text) => hashSkillText(text));
const mermaidSkill = builtIns.find((skill) => skill.name === "mermaid-diagrams") as Skill;

describe("built-in registry", () => {
	test("ships the mermaid-diagrams skill as a valid, trusted built-in", () => {
		expect(builtIns.map((skill) => skill.id)).toEqual(["built-in:mermaid-diagrams"]);
		expect(mermaidSkill).toMatchObject({ valid: true, source: "built-in", path: "", name: "mermaid-diagrams" });
		expect(mermaidSkill.diagnostics).toEqual([]);
		expect(mermaidSkill.manifest).toMatchObject({ title: "Mermaid diagrams", outputKind: "diagram", autoSuggest: true, accent: "#352fa0", version: "1.0.0" });
		expect(BUILT_IN_SKILL_NAMES.has("mermaid-diagrams")).toBe(true);
		expect(builtInSkillId("mermaid-diagrams")).toBe(mermaidSkill.id);
	});

	test("every built-in is valid, uniquely named, within its size cap and lint clean", () => {
		const seen = new Set<string>();
		for (const definition of BUILT_IN_SKILL_DEFINITIONS) {
			const skill = builtIns.find((item) => item.name === definition.name);
			expect(skill?.valid).toBe(true);
			expect(seen.has(definition.name)).toBe(false);
			seen.add(definition.name);
			expect(definition.body.length).toBeLessThanOrEqual(MAX_BUILT_IN_BODY);
			expect(skill?.characters).toBeLessThanOrEqual(MAX_BUILT_IN_BODY);
			expect(skill?.lint).toEqual([]);
			expect(definition.name).toBe(slugifySkillName(definition.name));
		}
	});

	test("the manifest respects the field caps", () => {
		expect(MERMAID_DIAGRAMS_SKILL.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
		expect(MERMAID_DIAGRAMS_SKILL.triggers.length).toBeLessThanOrEqual(MAX_TRIGGERS);
		for (const trigger of MERMAID_DIAGRAMS_SKILL.triggers) {
			expect(trigger.length).toBeLessThanOrEqual(MAX_TRIGGER_LENGTH);
		}
		expect(new Set(MERMAID_DIAGRAMS_SKILL.triggers).size).toBe(MERMAID_DIAGRAMS_SKILL.triggers.length);
	});

	test("the rendered SKILL.md is a spec compliant Agent Skill that other tools can load", () => {
		const text = renderBuiltInSkill(MERMAID_DIAGRAMS_SKILL);
		const frontmatter = Bun.YAML.parse(text.split("---")[1] ?? "") as Record<string, unknown>;
		expect(frontmatter.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		expect(String(frontmatter.name).length).toBeLessThanOrEqual(64);
		expect(String(frontmatter.description).length).toBeLessThanOrEqual(1024);
		expect(String(frontmatter.compatibility).length).toBeLessThanOrEqual(500);
		expect(text.split("\n").length).toBeLessThan(500);
		expect(text.endsWith("\n")).toBe(true);
	});

	test("the built-in text hashes the same on every load", async () => {
		const again = await loadBuiltInSkills(parseYaml, (text) => hashSkillText(text));
		expect(again[0]?.hash).toBe(mermaidSkill.hash);
		expect(again[0]?.hash).toBe(await hashSkillText(renderBuiltInSkill(MERMAID_DIAGRAMS_SKILL)));
	});
});

describe("mermaid-diagrams body", () => {
	const body = MERMAID_DIAGRAMS_SKILL.body;

	test("is outcome first, with the sections in order", () => {
		const headings = Array.from(body.matchAll(/^# (.+)$/gm), (match) => match[1]);
		expect(headings).toEqual(["Goal", "Success criteria", "Type choice", "Syntax rules", "Design brief", "Output", "Stop rules"]);
		expect(body.startsWith("# Goal")).toBe(true);
	});

	test("respects the body cap with room to spare", () => {
		expect(body.length).toBeLessThanOrEqual(MAX_BUILT_IN_BODY);
		expect(body.length).toBeGreaterThan(3000);
		expect(mermaidSkill.body).toBe(body.trim());
	});

	test("contains no double-brace sequences that a template engine could expand", () => {
		expect(body).not.toMatch(/\{\{/);
		expect(body).not.toMatch(/\}\}/);
	});

	test("contains none of the syntax it forbids", () => {
		const forbidden: Array<[string, RegExp]> = [
			["a URL", /https?:\/\/|www\./i],
			["a comment marker", /%%|<!--/],
			["a click directive", /^\s*click\s/im],
			["an init or directive block", /%%\{|\binit\s*[:{]/i],
			["theme configuration", /\btheme\s*:|themeVariables|themeCSS/i],
			["ELK layout", /layout\s*:\s*elk|renderer\s*:\s*elk/i],
			["a source identifier", /\[S\d+\]|\bS\d+\b/],
			["raw HTML other than the line break", /<(?!br\/>)[a-z!][^>]*>/i],
			["an unsupported type", /wardley|zenuml/i]
		];
		for (const [label, pattern] of forbidden) {
			expect({ label, found: pattern.test(body) }).toEqual({ label, found: false });
		}
	});

	test("tells the model never to write click handlers, URLs, init blocks, theme settings, ELK or source IDs", () => {
		const rule = body.split("\n").find((line) => /^- Never write /.test(line)) ?? "";
		for (const word of ["click", "URLs", "init", "theme", "ELK", "source"]) {
			expect({ word, present: rule.includes(word) }).toEqual({ word, present: true });
		}
	});

	test("hands styling to the plugin: colours are forbidden and the role meanings live in the design brief", () => {
		expect(body).toMatch(/Never write colours, fill or stroke values, style or classDef lines/);
		expect(body).toMatch(/write the body only/);
		expect(body).toMatch(/accTitle and accDescr/);
		expect(body).toMatch(/the colour roles with their meanings, and the types that take role tags/);
		// The example shows real role names. Their meanings and the list of taggable types belong to the brief alone.
		for (const role of ["primary", "success", "warn"]) {
			expect(body).toContain(`:::${role}`);
		}
		expect(body).not.toMatch(/\b(?:primary|accent|success|warn|danger|muted|ink) for\b/);
		expect(body).not.toMatch(/\bworks in flowchart, stateDiagram-v2/);
		expect(body).not.toMatch(/at most three roles/i);
	});

	test("asks for one block and at most one plain sentence, and says when to stop", () => {
		const output = body.split(/^# /m).find((part) => part.startsWith("Output\n")) ?? "";
		expect(output).toMatch(/Return one fenced mermaid code block\. After it, add one plain sentence only when you assumed something or left something out/);
		expect(output).toMatch(/No labels, no headings and no offers of further help/);
		// A labelled caption would be written into the note by Insert, New note and Apply.
		expect(body).not.toMatch(/Shows:|Assumptions:/);
		expect(body).not.toMatch(/offer (?:the|to)/i);
		expect(body).toMatch(/fix only that error/);
		expect(body).toMatch(/not asking for a diagram, skip this skill/);
	});

	test("a thin note gets the smallest supported diagram, and plain prose only when there is nothing to draw", () => {
		const stop = body.split(/^# /m).find((part) => part.startsWith("Stop rules\n")) ?? "";
		expect(stop).toMatch(/draw the smallest diagram it supports/);
		expect(stop).toMatch(/Only when there is nothing to draw, answer in one or two plain sentences/);
	});

	test("the type the user asks for wins, in the request or in the brief", () => {
		expect(body).toMatch(/If the user names a type, in the request or in the design brief, and it can show the content, use it/);
	});

	test("scopes the quoting rule: node labels are quoted, sequence message text is not", () => {
		expect(body).toMatch(/Put quotes around any node label \(not sequence message text\)/);
		expect(body).toMatch(/Sequence message text is never quoted and has no semicolons or hash characters \(write #59; and #35;\)/);
	});

	test("never asks for more than one diagram, so the answer stays inside the one block the plugin validates", () => {
		const section = (heading: string): string => body.split(/^# /m).find((part) => part.startsWith(`${heading}\n`)) ?? "";
		const prose = body.replace(/```[\s\S]*?```/g, "");
		expect(prose).not.toMatch(/\b(?:several|multiple|many|two|three|separate|further|more than one|extra|additional)\s+(?:mermaid\s+)?(?:diagrams|blocks|code blocks)\b/i);
		expect(prose).not.toMatch(/\b(?:split|divide|break)\b[^.\n]{0,40}\b(?:diagrams|blocks)\b/i);
		expect(section("Goal")).toMatch(/\bone Mermaid diagram\b/);
		expect(section("Output")).toMatch(/\bone fenced mermaid code block\b/);
		const output = section("Output");
		expect(output.match(/```mermaid/g) ?? []).toEqual([]);
	});

	test("larger content stays in the one diagram and what was left out is named in the sentence after it", () => {
		const criteria = body.split(/^# /m).find((part) => part.startsWith("Success criteria\n")) ?? "";
		const sizeRule = criteria.split("\n").find((line) => /12 nodes/.test(line)) ?? "";
		expect(sizeRule).toMatch(/one diagram/);
		expect(sizeRule).toMatch(/left out/);
		expect(sizeRule).toMatch(/sentence after the block/);
		expect(sizeRule).not.toMatch(/Assumptions|offer/i);
	});

	test("names every type the research found, with the exact keywords", () => {
		for (const keyword of [
			"flowchart", "sequenceDiagram", "erDiagram", "classDiagram", "stateDiagram-v2", "gantt", "timeline", "mindmap", "pie", "journey",
			"quadrantChart", "gitGraph", "sankey-beta", "xychart-beta", "architecture-beta", "block-beta", "radar-beta", "treemap-beta",
			"venn-beta", "ishikawa-beta", "kanban", "packet-beta", "C4Context"
		]) {
			expect({ keyword, present: body.includes(keyword) }).toEqual({ keyword, present: true });
		}
		expect(body).toContain("never graph");
	});

	test("survives the skill sanitiser untouched, so no instruction is silently dropped", () => {
		const cleaned = sanitiseSkillText(body);
		expect(cleaned.text).toBe(body.trim());
		expect(cleaned.invisibleRemoved).toBe(0);
		expect(cleaned.commentsRemoved).toBe(0);
		expect(lintSkillText(body)).toEqual([]);
	});

	test("is plain ASCII, so no look-alike or invisible character can hide in it", () => {
		expect(/[^\x20-\x7e\n]/.test(body)).toBe(false);
	});
});

describe("mermaid-diagrams examples parse with the Mermaid build Obsidian ships", () => {
	const examples = Array.from(MERMAID_DIAGRAMS_SKILL.body.matchAll(/```mermaid\n([\s\S]*?)\n```/g), (match) => match[1] ?? "");
	const saved = new Map<string, PropertyDescriptor | undefined>();
	let parse: ((text: string) => Promise<unknown>) | null = null;

	beforeAll(async () => {
		const { Window } = await import("happy-dom");
		const window = new Window();
		const globals: Record<string, unknown> = {
			window,
			document: window.document,
			DOMParser: window.DOMParser,
			Element: window.Element,
			HTMLElement: window.HTMLElement,
			SVGElement: window.SVGElement,
			Node: window.Node,
			getComputedStyle: window.getComputedStyle.bind(window),
			navigator: window.navigator
		};
		for (const [key, value] of Object.entries(globals)) {
			saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
		}
		const mermaid = (await import("mermaid")).default;
		mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
		parse = (text: string) => mermaid.parse(text, { suppressErrors: false });
	});

	afterAll(() => {
		for (const [key, descriptor] of saved) {
			if (descriptor) {
				Object.defineProperty(globalThis, key, descriptor);
			} else {
				Reflect.deleteProperty(globalThis, key);
			}
		}
	});

	test("there is one example for each newer type plus the role-tagged flowchart", () => {
		expect(examples.length).toBeGreaterThanOrEqual(12);
		const first = examples.map((example) => (example.split("\n")[0] ?? "").trim());
		for (const keyword of ["quadrantChart", "sankey-beta", "xychart-beta", "architecture-beta", "block-beta", "kanban", "radar-beta", "treemap-beta", "venn-beta", "ishikawa-beta", "packet-beta", "flowchart LR"]) {
			expect(first).toContain(keyword);
		}
	});

	test("every example parses", async () => {
		expect(parse).not.toBeNull();
		const failures: string[] = [];
		for (const example of examples) {
			try {
				await parse?.(example);
			} catch (error) {
				failures.push(`${example.split("\n")[0]}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
			}
		}
		expect(failures).toEqual([]);
	});

	test("the parser used here rejects the mistakes the Syntax rules warn about", async () => {
		const mistakes = [
			"flowchart LR\n    A[Cost (est)] --> B",
			"flowchart LR\n    A --> end",
			"flowchart LR\n    subgraph X\n    A --> B",
			"pie\n    \"A\" : 50%",
			"sequenceDiagram\n    A->>B: hello; world"
		];
		for (const mistake of mistakes) {
			await expect(parse?.(mistake) ?? Promise.resolve()).rejects.toBeDefined();
		}
	});
});

describe("starter templates", () => {
	test("offers five examples whose names are their folders", () => {
		expect(EXAMPLE_SKILL_TEMPLATES.map((template) => template.id)).toEqual([
			"meeting-minutes",
			"anki-flashcards",
			"weekly-review",
			"cornell-notes",
			"translate-keep-format"
		]);
		for (const template of EXAMPLE_SKILL_TEMPLATES) {
			expect(template.path).toBe(`${template.id}/SKILL.md`);
		}
	});

	test("every template parses without a warning, fits the vault caps and cannot shadow a built-in", async () => {
		for (const template of EXAMPLE_SKILL_TEMPLATES) {
			const skill = parseSkillFile({
				path: `AskMate/Skills/${template.path}`,
				raw: template.content,
				hash: await hashSkillText(template.content),
				source: "vault",
				fallbackName: template.id,
				parseYaml
			});
			expect({ id: template.id, valid: skill.valid, diagnostics: skill.diagnostics }).toEqual({ id: template.id, valid: true, diagnostics: [] });
			expect(skill.characters).toBeLessThanOrEqual(MAX_VAULT_BODY);
			expect(skill.manifest.triggers.length).toBeGreaterThan(0);
			expect(skill.lint).toEqual([]);
			expect(BUILT_IN_SKILL_NAMES.has(skill.name)).toBe(false);
			expect(template.content).not.toMatch(/\{\{|%%|<!--/);
			expect(sanitiseSkillText(skill.body).text).toBe(skill.body);
		}
	});

	test("the template that outputs a Markdown table carries the table cell rule every table workflow carries", () => {
		const cornell = EXAMPLE_SKILL_TEMPLATES.find((template) => template.id === "cornell-notes");
		expect(cornell?.content).toContain(TABLE_CELL_RULE);
		// Only the Cornell template writes a table, so no other starter needs the rule.
		for (const template of EXAMPLE_SKILL_TEMPLATES.filter((item) => item.id !== "cornell-notes")) {
			expect({ id: template.id, table: /Markdown table/i.test(template.content) }).toEqual({ id: template.id, table: false });
		}
	});

	test("a new skill scaffold parses and carries the name and description given", async () => {
		const scaffold = createSkillScaffold("My Reading Notes", "Summarises a book note. Use when the user asks for a reading summary: short and plain.");
		expect(scaffold.id).toBe("my-reading-notes");
		expect(scaffold.path).toBe("my-reading-notes/SKILL.md");
		const skill = parseSkillFile({ path: scaffold.path, raw: scaffold.content, hash: await hashSkillText(scaffold.content), source: "vault", fallbackName: scaffold.id, parseYaml });
		expect(skill.valid).toBe(true);
		expect(skill.manifest.title).toBe("My Reading Notes");
		expect(skill.manifest.description).toBe("Summarises a book note. Use when the user asks for a reading summary: short and plain.");
		expect(skill.diagnostics).toEqual([]);
	});

	test("a name with no Latin letters gets its own stable folder instead of a shared fallback (QA-15)", async () => {
		const pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
		const japanese = createSkillScaffold("会議議事録", "");
		const persian = createSkillScaffold("صورتجلسه", "");
		const symbols = createSkillScaffold("!!!", "");
		for (const scaffold of [japanese, persian, symbols]) {
			expect(scaffold.id).toMatch(pattern);
			expect(scaffold.id.length).toBeLessThanOrEqual(64);
			expect(scaffold.id).not.toBe("my-skill");
			expect(scaffold.path).toBe(`${scaffold.id}/SKILL.md`);
		}
		expect(new Set([japanese.id, persian.id, symbols.id]).size).toBe(3);
		expect(createSkillScaffold("会議議事録", "other").id).toBe(japanese.id);
		expect(createSkillScaffold("  会議議事録  ", "").id).toBe(japanese.id);
		expect(japanese.content).toContain("会議議事録");
		const skill = parseSkillFile({ path: japanese.path, raw: japanese.content, hash: await hashSkillText(japanese.content), source: "vault", fallbackName: japanese.id, parseYaml });
		expect(skill.valid).toBe(true);
		expect(skill.name).toBe(japanese.id);
		expect(skill.manifest.title).toBe("会議議事録");
		expect(skill.diagnostics).toEqual([]);
	});

	test("a mixed name keeps its transliterated slug", () => {
		expect(createSkillScaffold("Amélie O'Connor", "").id).toBe("amelie-o-connor");
	});

	test("a scaffold copes with an empty or unusable name and description", async () => {
		const scaffold = createSkillScaffold("   ", "   ");
		expect(scaffold.id).toBe("my-skill");
		const skill = parseSkillFile({ path: scaffold.path, raw: scaffold.content, hash: await hashSkillText(scaffold.content), source: "vault", fallbackName: scaffold.id, parseYaml });
		expect(skill.valid).toBe(true);
		const tricky = createSkillScaffold("Quote \"and\" colon: here", "Has \"quotes\", a colon: and a # hash");
		const parsed = parseSkillFile({ path: tricky.path, raw: tricky.content, hash: await hashSkillText(tricky.content), source: "vault", fallbackName: tricky.id, parseYaml });
		expect(parsed.valid).toBe(true);
		expect(parsed.manifest.description).toBe("Has \"quotes\", a colon: and a # hash");
		expect(parsed.diagnostics).toEqual([]);
	});
});
