import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * Structural guards for styles.css: the Obsidian community review rules, the brand token discipline, accessibility
 * behaviour (focus ring, reduced motion, forced colours) and the fixes for the CSS defects found in the 1.11.1 audit.
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
			".askmate-sidebar.askmate-composer-layout-console .askmate-message-system:not(.askmate-console-echo, .askmate-console-output, .askmate-onboarding-message, .askmate-message-has-image, .askmate-message-card) .askmate-message-body::before"
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
