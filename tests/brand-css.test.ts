import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../scripts/roadmap-smoke-tests";

/*
 * Structural guards for styles.css: the Obsidian community review rules, the brand token discipline, accessibility
 * behaviour (focus ring, reduced motion, forced colours), the fixes for the CSS defects found in the 1.11.1 audit, and the
 * match between the stylesheet and the markup the code emits (classes and state classes, in both directions).
 */

interface Rule {
	selector: string;
	body: string;
	/** The enclosing at-rule preludes, outermost first, or an empty string at the top level. */
	at: string;
}

const raw = readFileSync("styles.css", "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

function parseRules(source: string): Rule[] {
	const rules: Rule[] = [];
	const stack: string[] = [];
	let buffer = "";
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		if (char === "{") {
			const prelude = buffer.trim();
			buffer = "";
			if (prelude.startsWith("@") && !prelude.startsWith("@keyframes")) {
				stack.push(prelude);
				index += 1;
				continue;
			}
			let depth = 1;
			let end = index + 1;
			while (end < source.length && depth > 0) {
				if (source[end] === "{") {
					depth += 1;
				} else if (source[end] === "}") {
					depth -= 1;
				}
				end += 1;
			}
			rules.push({ selector: prelude.replace(/\s+/g, " "), body: source.slice(index + 1, end - 1), at: stack.join(" ") });
			index = end;
			continue;
		}
		if (char === "}") {
			stack.pop();
			buffer = "";
			index += 1;
			continue;
		}
		buffer += char;
		index += 1;
	}
	return rules;
}

const rules = parseRules(css);

/** Splits a selector list on its top-level commas, so :not(a, b) stays in one piece. */
function splitSelectorList(list: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of list) {
		if (char === "(") {
			depth += 1;
		} else if (char === ")") {
			depth -= 1;
		}
		if (char === "," && depth === 0) {
			parts.push(current.trim());
			current = "";
		} else {
			current += char;
		}
	}
	parts.push(current.trim());
	return parts;
}

function selectors(rule: Rule): string[] {
	return splitSelectorList(rule.selector);
}

type Specificity = readonly [ids: number, classes: number, elements: number];

function compareSpecificity(a: Specificity, b: Specificity): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Selector specificity, with :is() and :not() taking their widest argument and :where() counting for nothing. */
function specificity(selector: string): Specificity {
	const nested: Specificity[] = [];
	const flat = selector.replace(/:(is|not|where)\(((?:[^()]|\([^()]*\))*)\)/g, (_match, name: string, args: string) => {
		if (name !== "where") {
			nested.push(splitSelectorList(args).map(specificity).reduce((widest, next) => (compareSpecificity(next, widest) > 0 ? next : widest)));
		}
		return "";
	});
	const own: Specificity = [
		(flat.match(/#[\w-]+/g) ?? []).length,
		(flat.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g) ?? []).length,
		(flat.match(/(?:^|[\s>+~])[a-z][\w-]*|::[\w-]+/g) ?? []).length
	];
	return nested.reduce<Specificity>((total, next) => [total[0] + next[0], total[1] + next[1], total[2] + next[2]], own);
}

/** The rules whose selector list contains exactly this selector, outside any at-rule unless `at` is given. */
function findRules(selector: string, at = ""): Rule[] {
	return rules.filter((rule) => rule.at === at && selectors(rule).includes(selector));
}

function declaration(rule: Rule, property: string): string | undefined {
	const match = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`).exec(rule.body);
	return match?.[1]?.trim();
}

function declarationOf(selector: string, property: string, at = ""): string | undefined {
	return findRules(selector, at).map((rule) => declaration(rule, property)).filter((value) => value !== undefined).at(-1);
}

describe("community review rules", () => {
	test("avoids :has, clip-path and column-gap", () => {
		expect(css).not.toMatch(/:has\(/);
		expect(css).not.toMatch(/clip-path/);
		expect(css).not.toMatch(/column-gap/);
	});

	test("sets no pixel font sizes, so text scales with Obsidian's font settings", () => {
		expect(css.match(/font-size:\s*\d+(\.\d+)?px/g) ?? []).toEqual([]);
	});
});

describe("brand token discipline", () => {
	const tokenBlocks = rules.filter((rule) => rule.at === "" && (rule.selector === "body" || rule.selector === "body.theme-dark"));
	const outsideTokens = rules.filter((rule) => !tokenBlocks.includes(rule));

	test("defines the palette in one light block and one dark block", () => {
		expect(tokenBlocks.map((rule) => rule.selector)).toEqual(["body", "body.theme-dark"]);
	});

	test("hard-codes no colour outside the token blocks, apart from black shadows", () => {
		const offenders: string[] = [];
		for (const rule of outsideTokens) {
			const withoutShadows = rule.body.replace(/rgba\(0,\s*0,\s*0,\s*[0-9.]+\)/g, "");
			for (const literal of withoutShadows.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/g) ?? []) {
				offenders.push(`${rule.selector}: ${literal}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("uses text-faint only for decorative marks, never for text that carries information", () => {
		const decorative = new Set([
			".askmate-sidebar.askmate-composer-layout-console .askmate-message-system:not(.askmate-console-echo, .askmate-console-output, .askmate-onboarding-message, .askmate-message-has-image) .askmate-message-body::before"
		]);
		const offenders = outsideTokens
			.filter((rule) => /color:\s*var\(--text-faint\)/.test(rule.body))
			.filter((rule) => !selectors(rule).every((selector) => decorative.has(selector)))
			.map((rule) => rule.selector);
		expect(offenders).toEqual([]);
	});

	test("never sets the colour of Obsidian surfaces or text", () => {
		expect(css).not.toMatch(/--(?:background-(?:primary|secondary)[a-z-]*|text-(?:normal|muted|faint)):/);
	});
});

describe("component styles from the wave 2 contract", () => {
	const contractClasses = [
		"askmate-setup-card", "askmate-setup-title", "askmate-setup-step", "askmate-setup-providers", "askmate-setup-provider",
		"askmate-setup-key-row", "askmate-setup-actions", "askmate-setup-error", "askmate-starter-chips", "askmate-starter-chip",
		"askmate-skill-chips", "askmate-skill-chip", "askmate-skill-badge",
		"askmate-diagram-card", "askmate-diagram-card-header", "askmate-diagram-meta", "askmate-diagram-preview",
		"askmate-diagram-actions", "askmate-diagram-fallback", "askmate-diagram-placeholder",
		"askmate-tool-card", "askmate-tool-card-header", "askmate-tool-args", "askmate-tool-result", "askmate-tool-approval-actions",
		"askmate-status-chip", "askmate-skill-row", "askmate-mcp-row", "askmate-settings-callout",
		"askmate-approval-modal", "askmate-trust-modal", "askmate-skill-review-modal", "askmate-modal-buttons",
		"askmate-brand-mark"
	];

	test("every contract class has a rule", () => {
		const missing = contractClasses.filter((name) => !new RegExp(`\\.${name}(?![a-z0-9-])`).test(css));
		expect(missing).toEqual([]);
	});

	test("every contract state class is styled", () => {
		const states = [
			".askmate-setup-step.is-done", ".askmate-setup-step.is-current", ".askmate-setup-provider.is-selected",
			".askmate-skill-chip.is-active", ".askmate-skill-chip.is-suggested",
			".askmate-tool-card.is-pending", ".askmate-tool-card.is-running", ".askmate-tool-card.is-done", ".askmate-tool-card.is-error", ".askmate-tool-card.is-denied",
			".askmate-status-chip.is-ready", ".askmate-status-chip.is-warning", ".askmate-status-chip.is-error", ".askmate-status-chip.is-off", ".askmate-status-chip.is-busy"
		];
		const styled = (state: string): boolean => rules.some((rule) => selectors(rule).some((selector) => selector === state || selector.startsWith(`${state}:`) || selector.startsWith(`${state} `)));
		const missing = states.filter((state) => !styled(state));
		expect(missing).toEqual([]);
	});

	test("status chips and tool cards show their state with a glyph as well as a colour", () => {
		for (const state of ["is-ready", "is-warning", "is-error", "is-off", "is-busy"]) {
			const rule = findRules(`.askmate-status-chip.${state}::before`)[0];
			expect(rule, `.askmate-status-chip.${state}::before`).toBeDefined();
			expect(declaration(rule as Rule, "content")).toBeDefined();
		}
		for (const state of ["is-pending", "is-running", "is-done", "is-error", "is-denied"]) {
			const rule = findRules(`.askmate-tool-card.${state} > .askmate-tool-card-header::before`)[0];
			expect(rule, `tool card ${state}`).toBeDefined();
			expect(declaration(rule as Rule, "content")).toBeDefined();
		}
	});
});

describe("accessibility behaviour", () => {
	test("the focus ring is a solid 2px accent outline, not a transparent outline with a faint shadow", () => {
		const ring = rules.find((rule) => rule.at === "" && selectors(rule).some((selector) => selector.includes(":focus-visible")) && declaration(rule, "outline")?.includes("--askmate-focus"));
		expect(ring, "a :focus-visible rule using --askmate-focus").toBeDefined();
		expect(declaration(ring as Rule, "outline")).toBe("2px solid var(--askmate-focus)");
		expect(css).not.toMatch(/outline:\s*\d+px solid transparent/);
		expect(css).not.toContain("--askmate-focus-ring");
	});

	/** The base ring rule, and its selector for controls (as opposed to the three shells that draw their own ring). */
	function ringRule(): { rule: Rule; control: string } {
		const rule = rules.find((candidate) => candidate.at === "" && declaration(candidate, "outline")?.includes("--askmate-focus")) as Rule;
		const control = selectors(rule).find((selector) => selector.includes(":focus-visible")) as string;
		return { rule, control };
	}

	test("the ring also covers text fields, textareas and checkboxes, so Obsidian's faint glow never shows on them", () => {
		const { rule, control } = ringRule();
		const covered = splitSelectorList(/:is\(([^)]*)\)/.exec(control)?.[1] ?? "");
		for (const target of ["button", "select", "summary", "a", "input", "textarea", "[tabindex]"]) {
			expect(covered, `the ring covers ${target}`).toContain(target);
		}
		expect(declaration(rule, "box-shadow"), "the glow is replaced, not stacked").toBe("none");
		expect(selectors(rule)).toContain(".askmate-input-shell:focus-within");
	});

	test("the prompt box is left to its shell, which draws the ring around the scrolling text", () => {
		expect(ringRule().control).toContain(":where(:not(.askmate-question))");
		expect(declarationOf(".askmate-question", "outline")).toBe("none");
		expect(declarationOf(".askmate-question", "box-shadow")).toBe("none");
	});

	test("the exclusion adds no specificity, so component overrides keep winning over the base ring", () => {
		expect(specificity(".a :is(button, input, [tabindex]):where(:not(.b)):focus-visible")).toEqual([0, 3, 0]);
		expect(specificity(".a .b button:focus-visible")).toEqual([0, 3, 1]);
		expect(specificity("p::before")).toEqual([0, 0, 2]);
		const { control } = ringRule();
		expect(specificity(control)).toEqual([0, 3, 0]);
		const insetBar = ".askmate-sidebar .askmate-console-status button:focus-visible";
		expect(declarationOf(insetBar, "outline-offset")).toBe("-2px");
		expect(compareSpecificity(specificity(insetBar), specificity(control)), "the inset ring in the status bar").toBeGreaterThan(0);
	});

	test("the filled console buttons draw an inward ring in their own text colour, because the brand ring would vanish into the fill", () => {
		const { control } = ringRule();
		const filled = [
			{ selector: ".askmate-sidebar .askmate-console-status .askmate-console-segment.is-mode:focus-visible", colour: "var(--askmate-on-brand)" },
			{ selector: ".askmate-sidebar .askmate-console-status .askmate-console-stop:focus-visible", colour: "var(--askmate-on-danger)" }
		];
		for (const { selector, colour } of filled) {
			expect(declarationOf(selector, "outline-color"), selector).toBe(colour);
			expect(Number.parseFloat(declarationOf(selector, "outline-offset") ?? "0"), `${selector} is drawn inside the fill`).toBeLessThan(0);
			expect(compareSpecificity(specificity(selector), specificity(control)), `${selector} beats the base ring`).toBeGreaterThan(0);
		}
	});

	test("every animation has a reduced-motion override", () => {
		const reduced = rules.filter((rule) => rule.at.includes("prefers-reduced-motion"));
		const reducedSelectors = new Set(reduced.flatMap((rule) => selectors(rule)));
		const animated = rules.filter((rule) => rule.at === "" && /(?:^|;|\s)animation:\s*(?!none)/.test(rule.body));
		expect(animated.length).toBeGreaterThan(0);
		for (const rule of animated) {
			for (const selector of selectors(rule)) {
				expect(reducedSelectors.has(selector), `reduced motion override for ${selector}`).toBe(true);
			}
		}
	});

	test("forced colours keep a focus outline and borders on chips and cards", () => {
		const forced = rules.filter((rule) => rule.at.includes("forced-colors"));
		expect(forced.length).toBeGreaterThan(0);
		expect(forced.some((rule) => /outline:\s*2px solid CanvasText/.test(rule.body))).toBe(true);
		expect(forced.some((rule) => selectors(rule).includes(".askmate-status-chip") && /border:\s*1px solid CanvasText/.test(rule.body))).toBe(true);
		// The forced-colours ring covers the same controls as the base ring, text fields and checkboxes included.
		const forcedControl = forced.flatMap(selectors).find((selector) => selector.includes(":focus-visible")) as string;
		expect(forcedControl).toBe(ringRule().control);
	});

	test("uses logical properties so the sidebar mirrors in right-to-left languages", () => {
		const physical = /(?:^|;|\s)(?:margin-left|margin-right|padding-left|padding-right|border-left|border-right|text-align:\s*(?:left|right))\b/;
		const offenders = rules.filter((rule) => physical.test(rule.body)).map((rule) => rule.selector);
		expect(offenders).toEqual([]);
	});

	test("lets the log and modal text be selected and copied", () => {
		const rule = rules.find((candidate) => candidate.at === "" && selectors(candidate).includes(".askmate-messages") && /user-select:\s*text/.test(candidate.body));
		expect(rule).toBeDefined();
		const hidden = findRules(".askmate-sidebar.askmate-composer-layout-console .askmate-message-header")[0];
		expect(declaration(hidden as Rule, "display")).toBeUndefined();
		expect(declaration(hidden as Rule, "position")).toBe("absolute");
	});

	test("shows a busy state without animation, so reduced-motion users still see progress", () => {
		const placeholder = findRules(".askmate-message-assistant .askmate-message-body:empty::before")[0];
		expect(declaration(placeholder as Rule, "content")).toContain("Working");
	});
});

describe("defects found in the 1.11.1 audit", () => {
	test("CSS-01: modal button rows are flex rows with a gap, and the prompt input is full width", () => {
		expect(declarationOf(".askmate-modal-actions", "display")).toBe("flex");
		expect(declarationOf(".askmate-modal-actions", "justify-content")).toBe("flex-end");
		expect(declarationOf(".askmate-modal-actions", "gap")).toBeDefined();
		expect(declarationOf(".askmate-modal-buttons", "justify-content")).toBe("flex-end");
		expect(declarationOf(".askmate-modal-actions > .mod-warning", "margin-inline-end")).toBe("auto");
		expect(declarationOf(".askmate-modal-input", "width")).toBe("100%");
	});

	test("CSS-02: rendered code follows the user's monospace font and Obsidian's code tokens", () => {
		for (const selector of [".askmate-rendered-markdown code", ".askmate-rendered-markdown pre"]) {
			expect(declarationOf(selector, "font-family")).toBe("var(--font-monospace)");
			expect(declarationOf(selector, "background")).toContain("--code-background");
			expect(declarationOf(selector, "border")).toBeDefined();
		}
		expect(declarationOf(".askmate-rendered-markdown code", "color")).toContain("--code-normal");
		expect(declarationOf(".askmate-rendered-markdown pre code", "background")).toBe("transparent");
	});

	test("CSS-03: images and diagrams cannot push the message pane wider than the sidebar", () => {
		expect(declarationOf(".askmate-rendered-markdown img", "max-width")).toBe("100%");
		expect(declarationOf(".askmate-rendered-markdown img", "height")).toBe("auto");
		expect(declarationOf(".askmate-rendered-markdown .mermaid", "overflow-x")).toBe("auto");
		expect(declarationOf(".askmate-rendered-markdown", "min-width")).toBe("0");
		expect(declarationOf(".askmate-diagram-preview", "overflow")).toBe("auto");
	});

	test("CSS-04: the composer header wraps, shrinks the brand pill and never scrolls sideways", () => {
		expect(declarationOf(".askmate-composer-header-left", "flex-wrap")).toBe("wrap");
		expect(declarationOf(".askmate-composer-brand", "text-overflow")).toBe("ellipsis");
		expect(declarationOf(".askmate-composer-brand", "min-width")).toBe("0");
		expect(declarationOf(".askmate-composer", "overflow-x")).toBe("hidden");
	});

	test("CSS-05: the console dot is not drawn before cards and image previews", () => {
		const dot = rules.find((rule) => rule.selector.endsWith(".askmate-message-body::before") && rule.selector.includes(".askmate-message-system:not("));
		expect(dot).toBeDefined();
		expect(dot?.selector).toContain(".askmate-onboarding-message");
		expect(dot?.selector).toContain(".askmate-message-has-image");
	});

	test("CSS-06: the incomplete-reply warning keeps its zero margin over the budget warning", () => {
		const budget = findRules(".askmate-budget-warning")[0] as Rule;
		const warning = findRules(".askmate-message .askmate-message-incomplete-warning")[0] as Rule;
		expect(warning, "a two-class selector").toBeDefined();
		expect(declaration(warning, "margin")).toBe("0");
		expect(declaration(budget, "margin")).toBeDefined();
	});
});

describe("defects found in the launch QA of 18/10/2026", () => {
	test("QA-01: the composer scrolls instead of crushing the question box, and leaves the sidebar's other half to the chat", () => {
		expect(declarationOf(".askmate-composer > *", "flex-shrink")).toBe("0");
		expect(declarationOf(".askmate-composer", "max-height")).toBe("50%");
		expect(declarationOf(".askmate-sidebar.askmate-setup-open .askmate-request-preview", "display")).toBe("none");
		expect(declarationOf(".askmate-sidebar.askmate-setup-open .askmate-composer", "max-height")).toBe("35%");
	});

	test("QA-04: the checkbox inside a settings switch is not rendered, so it is not a second, nested control", () => {
		expect(declarationOf(".checkbox-container > input.askmate-switch-input", "display")).toBe("none");
	});

	test("QA-07: primary buttons in AskMate's dialogs and settings pages use the tested brand pair, not the theme accent", () => {
		for (const selector of [".askmate-modal-buttons button.mod-cta", "button.mod-cta.askmate-cta"]) {
			expect(declarationOf(selector, "background")).toBe("var(--askmate-brand)");
			expect(declarationOf(selector, "color")).toBe("var(--askmate-on-brand)");
		}
	});

	test("QA-16: header icon buttons meet the 24px target size, and the reasoning picker's text stays hidden in forced colours", () => {
		expect(declarationOf(".askmate-context-button", "width")).toBe("24px");
		expect(declarationOf(".askmate-context-button", "height")).toBe("24px");
		const forced = rules.filter((rule) => rule.at.includes("forced-colors") && selectors(rule).includes(".askmate-reasoning-select"));
		expect(forced).toHaveLength(1);
		expect(declaration(forced[0] as Rule, "forced-color-adjust")).toBe("none");
	});

	test("QA-03: in forced colours the sidebar's checkboxes use the native box, so a ticked box does not look empty", () => {
		const forced = rules.filter((rule) => rule.at.includes("forced-colors") && selectors(rule).includes('.askmate-sidebar input[type="checkbox"]'));
		expect(forced).toHaveLength(1);
		expect(declaration(forced[0] as Rule, "appearance")).toBe("auto");
	});
});

describe("what follows a reply in the message grid", () => {
	test("tool cards, the diagram card and the drawing note span every column, so none lands in the avatar column", () => {
		for (const selector of [".askmate-message > .askmate-tool-cards", ".askmate-message > .askmate-diagram-card", ".askmate-message > .askmate-diagram-placeholder"]) {
			expect(declarationOf(selector, "grid-column"), selector).toBe("1 / -1");
			expect(declarationOf(selector, "min-width"), selector).toBe("0");
		}
	});

	test("the drawing note under a reply is one quiet line, not the preview-sized box it is inside the card", () => {
		expect(declarationOf(".askmate-diagram-placeholder", "min-height")).toBe("96px");
		expect(declarationOf(".askmate-message > .askmate-diagram-placeholder", "min-height")).toBe("0");
	});

	test("a failed reply is styled through the class the view sets on it, with a mark as well as a colour", () => {
		const error = ".askmate-message.askmate-message-error";
		expect(declarationOf(error, "background")).toContain("--askmate-danger");
		expect(declarationOf(`${error} .askmate-message-body::before`, "content")).toBe("\"! \"");
	});

	test("the caret and the pulse follow the sidebar's loading class, which is the state the view really sets", () => {
		const animated = rules.filter((rule) => rule.at === "" && /(?:^|;|\s)animation:\s*(?!none)/.test(rule.body) && selectors(rule).some((selector) => selector.includes(".askmate-messages")));
		expect(animated.length).toBeGreaterThan(0);
		for (const rule of animated) {
			for (const selector of selectors(rule)) {
				expect(selector, "tied to the loading state of the sidebar").toContain(".askmate-sidebar.is-loading");
			}
		}
	});

	test("elements the code hides with the hidden attribute are not kept visible by a display in their own rule", () => {
		for (const name of ["askmate-skill-chips", "askmate-draft-undo", "askmate-tool-approval-actions", "askmate-status-chip"]) {
			expect(declarationOf(`.${name}`, "display"), `${name} sets a display`).toBeDefined();
			expect(declarationOf(`.${name}[hidden]`, "display"), `${name}[hidden]`).toBe("none");
		}
	});

	test("scrollable regions show the focus ring inside their edge, because Obsidian removes the default outline and a card clips one outside", () => {
		for (const selector of [
			".askmate-tool-args:focus-visible", ".askmate-tool-result:focus-visible", ".askmate-diff-view:focus-visible", ".askmate-diagram-preview:focus-visible",
			".askmate-diagram-fallback pre:focus-visible", ".askmate-setup-error pre:focus-visible", ".askmate-rendered-markdown pre:focus-visible",
			".askmate-rendered-markdown table:focus-visible", ".askmate-rendered-markdown .mermaid:focus-visible", ".askmate-usage-table-wrapper:focus-visible"
		]) {
			expect(declarationOf(selector, "outline"), selector).toBe("2px solid var(--askmate-focus)");
			expect(declarationOf(selector, "outline-offset"), selector).toBe("-2px");
		}
	});

	test("Mermaid's scratch container stays laid out off screen, because Mermaid cannot measure text in a display: none box", () => {
		const scratch = ".askmate-mermaid-scratch";
		expect(declarationOf(scratch, "position")).toBe("absolute");
		expect(declarationOf(scratch, "visibility")).toBe("hidden");
		expect(declarationOf(scratch, "display")).toBeUndefined();
		expect(Number.parseInt(declarationOf(scratch, "inset-inline-start") ?? "0", 10)).toBeLessThanOrEqual(-1000);
		expect(declarationOf(scratch, "width")).toMatch(/^\d+px$/);
	});

	test("the skill review draws its diff in one column, because its rows carry no line numbers", () => {
		expect(declarationOf(".askmate-skill-review-modal .askmate-diff-line", "grid-template-columns")).toBe("minmax(0, 1fr)");
		expect(declarationOf(".askmate-diff-line", "grid-template-columns")).toBe("48px 48px 1fr");
	});

	test("a status chip inside the console status bar is flattened, after the chip states so its divider keeps the bar's colour", () => {
		const flat = rules.findIndex((rule) => rule.at === "" && rule.selector === ".askmate-console-segment.askmate-status-chip");
		const states = rules.findIndex((rule) => rule.at === "" && rule.selector === ".askmate-status-chip.is-busy");
		expect(flat).toBeGreaterThan(states);
		expect(declarationOf(".askmate-console-segment.askmate-status-chip", "border-radius")).toBe("0");
		expect(declarationOf(".askmate-console-segment.askmate-status-chip", "border-inline-end")).toContain("--askmate-border");
	});

	test("the Status row accent has the weight to beat the grouped settings rule that resets a row's border", () => {
		expect(declarationOf(".setting-item.askmate-settings-setup", "border-inline-start")).toContain("--askmate-warning");
		expect(compareSpecificity(specificity(".setting-item.askmate-settings-setup"), specificity(".setting-group .setting-item"))).toBeGreaterThanOrEqual(0);
	});
});

/** Every `.ts` file under a directory, in a stable order. */
function sourceFiles(dir: string): string[] {
	return readdirSync(dir).sort().flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
	});
}

const isQuote = (char: string | undefined): boolean => char === "\"" || char === "'" || char === "`";

/** The index just after the string literal that starts at `start`, stepping over the ${} parts of a template literal. */
function skipString(source: string, start: number): number {
	const quote = source[start];
	let index = start + 1;
	while (index < source.length) {
		if (source[index] === "\\") {
			index += 2;
		} else if (quote === "`" && source[index] === "$" && source[index + 1] === "{") {
			index = skipBraces(source, index + 2);
		} else if (source[index] === quote) {
			return index + 1;
		} else {
			index += 1;
		}
	}
	return index;
}

/** The index just after the `}` that closes a block whose `{` came just before `start`. */
function skipBraces(source: string, start: number): number {
	let depth = 1;
	let index = start;
	while (index < source.length && depth > 0) {
		if (isQuote(source[index])) {
			index = skipString(source, index);
			continue;
		}
		depth += source[index] === "{" ? 1 : source[index] === "}" ? -1 : 0;
		index += 1;
	}
	return index;
}

/** The index of the `,` or closing bracket that ends the expression starting at `start`. */
function expressionEnd(source: string, start: number): number {
	let depth = 0;
	let index = start;
	while (index < source.length) {
		const char = source[index];
		if (isQuote(char)) {
			index = skipString(source, index);
			continue;
		}
		if (char === "(" || char === "[" || char === "{") {
			depth += 1;
		} else if (char === ")" || char === "]" || char === "}") {
			if (depth === 0) {
				return index;
			}
			depth -= 1;
		} else if (char === "," && depth === 0) {
			return index;
		}
		index += 1;
	}
	return index;
}

/** The fixed text of every string literal in source[start, end), including literals inside the ${} parts of a template. */
function fixedTexts(source: string, start: number, end: number): string[] {
	const texts: string[] = [];
	let index = start;
	while (index < end) {
		const quote = source[index];
		if (!isQuote(quote)) {
			index += 1;
			continue;
		}
		let text = "";
		index += 1;
		while (index < end && source[index] !== quote) {
			if (source[index] === "\\") {
				text += source[index + 1] ?? "";
				index += 2;
			} else if (quote === "`" && source[index] === "$" && source[index + 1] === "{") {
				const close = skipBraces(source, index + 2);
				texts.push(text, ...fixedTexts(source, index + 2, close - 1));
				text = "";
				index = close;
			} else {
				text += source[index];
				index += 1;
			}
		}
		texts.push(text);
		index += 1;
	}
	return texts;
}

/** The ways the source gives an element a class. `every` means all arguments are class names, not just the first. */
const CLASS_CALLS: ReadonlyArray<{ pattern: RegExp; every: boolean }> = [
	{ pattern: /\bcls\s*:\s*/g, every: false },
	{ pattern: /\.className\s*=\s*/g, every: false },
	{ pattern: /\.(?:addClass|setClass)\(\s*/g, every: true },
	{ pattern: /\.classList\.add\(\s*/g, every: true },
	{ pattern: /\.(?:toggleClass|classList\.toggle)\(\s*/g, every: false }
];

/** The fixed `askmate-*` class names a source file puts on elements. A name built from a prefix (`askmate-message-${role}`) is not one. */
function classesSetBy(source: string): string[] {
	const found: string[] = [];
	for (const { pattern, every } of CLASS_CALLS) {
		for (const match of source.matchAll(pattern)) {
			let position = (match.index ?? 0) + match[0].length;
			for (;;) {
				const end = expressionEnd(source, position);
				found.push(...fixedTexts(source, position, end).flatMap((text) => text.split(/\s+/)));
				if (!every || source[end] !== ",") {
					break;
				}
				position = end + 1;
			}
		}
	}
	return found.filter((token) => /^askmate-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token));
}

describe("the stylesheet and the markup agree", () => {
	const files = [...sourceFiles("src"), "main.ts"];
	const code = files.map((file) => stripComments(readFileSync(file, "utf8")));
	const emitted = new Map<string, string[]>();
	files.forEach((file, index) => {
		for (const name of classesSetBy(code[index] ?? "")) {
			emitted.set(name, [...(emitted.get(name) ?? []), file]);
		}
	});
	const styled = new Set(Array.from(css.matchAll(/\.(askmate-[a-z0-9-]+)/g), (match) => match[1] ?? ""));

	/**
	 * Classes the code sets that deliberately have no rule of their own. Each marks an element for code or a test to find, and the
	 * look comes from the classes beside it. A class that gains a rule, or that the code stops setting, must leave this list.
	 */
	const MARKERS: Readonly<Record<string, string>> = {
		"askmate-action-label": "the words of an icon button, found by the code that renames them; askmate-visually-hidden beside it hides them",
		"askmate-avatar-person": "wraps the drawing of a person; its head and body carry the look",
		"askmate-composer-layout-compact": "the default layout is the base styles; only the other two layouts have rules",
		"askmate-diff-modal": "marks the content of the Apply preview dialog; the dialog's width is askmate-modal-wide on the modal",
		"askmate-message-action-more": "names the More actions button, which looks like every other reply action",
		"askmate-note-history": "marks the content of the note history dialog",
		"askmate-prompt-inspector": "marks the content of the prompt inspector dialog",
		"askmate-review-queue": "groups the pending review cards, which carry the look"
	};

	test("the scan finds the classes the code sets, in every form it sets them", () => {
		expect(classesSetBy("a.createDiv({ cls: \"askmate-one askmate-two\" }); b.addClass(\"askmate-three\", \"x\"); c.classList.toggle(\"askmate-four\", on);")).toEqual(["askmate-one", "askmate-two", "askmate-three", "askmate-four"]);
		expect(classesSetBy("d.createDiv({ cls: `askmate-card is-${s}${f ? \" askmate-flag\" : \"\"}` });")).toEqual(["askmate-card", "askmate-flag"]);
		expect(classesSetBy("e.createDiv({ cls: [\"modal-button-container\", \"askmate-buttons\"], text: \"askmate-not-a-class\" });")).toEqual(["askmate-buttons"]);
		expect(classesSetBy("f.createDiv({ cls: `askmate-message askmate-message-${role}` });")).toEqual(["askmate-message"]);
		expect(emitted.size).toBeGreaterThan(150);
	});

	test("every class the code puts on an element has a rule, or is a declared marker", () => {
		const unstyled = [...emitted.keys()].filter((name) => !styled.has(name) && !(name in MARKERS)).sort();
		expect(unstyled, "style these in styles.css, or add them to MARKERS with the reason they need no rule").toEqual([]);
	});

	test("every declared marker is still set by the code and still has no rule", () => {
		for (const name of Object.keys(MARKERS)) {
			expect(emitted.has(name), `${name} is no longer set by the code`).toBe(true);
			expect(styled.has(name), `${name} has a rule now`).toBe(false);
		}
	});

	test("every state class in the stylesheet is one the code sets", () => {
		/** States the code builds with a template, such as is-${tone}, by the values the template can take. */
		const templated = new Set([
			"ready", "warning", "error", "off", "busy",
			"mode", "setup", "model", "effort", "usage", "skills", "mcp",
			"near", "over",
			"done", "current", "todo",
			"pending", "running", "denied",
			"drawn", "repaired", "fallback",
			"connect", "testing", "failed", "connected"
		]);
		const joined = code.join("\n");
		const states = Array.from(new Set(Array.from(css.matchAll(/\.(?:is|has)-[a-z0-9-]+/g), (match) => match[0].slice(1))));
		const dead = states.filter((state) => {
			const literal = new RegExp(`(?<![a-z0-9-])${state}(?![a-z0-9-])`).test(joined);
			return !literal && !(state.startsWith("is-") && templated.has(state.slice(3)));
		});
		expect(dead, "state classes that nothing sets").toEqual([]);
	});
});

describe("the suggestion list for slash commands and mentions", () => {
	const list = ".askmate-console-completions";
	const shown = `${list}:not([hidden])`;

	/** Every top-level rule that sets a display on the list, whatever layout it is scoped to. */
	const listDisplayRules = rules.filter(
		(rule) => rule.at === "" && selectors(rule).some((selector) => selector.includes(list)) && declaration(rule, "display") !== undefined
	);

	test("is shown in every composer layout, because Compact and Expanded read commands and mentions too", () => {
		const visible = listDisplayRules.filter((rule) => declaration(rule, "display") === "block");
		expect(visible.length, "a rule that shows the list").toBeGreaterThan(0);
		for (const rule of visible) {
			for (const selector of selectors(rule)) {
				expect(selector, "not tied to the Console layout").not.toContain("askmate-composer-layout");
			}
		}
		expect(declarationOf(shown, "display")).toBe("block");
	});

	test("the shown rule outranks the rule that hides the list by default, and still honours the hidden attribute", () => {
		const hiding = listDisplayRules
			.filter((rule) => declaration(rule, "display") === "none")
			.flatMap(selectors)
			.filter((selector) => selector.includes(list));
		expect(hiding.length, "a rule that hides the list by default").toBeGreaterThan(0);
		for (const selector of hiding) {
			expect(compareSpecificity(specificity(shown), specificity(selector)), `${shown} against ${selector}`).toBeGreaterThan(0);
		}
		expect(shown).toContain(":not([hidden])");
	});

	test("scrolls instead of growing, so a long list never pushes the prompt off the sidebar", () => {
		expect(declarationOf(shown, "max-height")).toBe("220px");
		expect(declarationOf(shown, "overflow-y")).toBe("auto");
	});
});
