import { describe, expect, test } from "bun:test";
import { describeBudgetEnforcement, describeBudgetUsage, getBudgetFillPercent } from "../src/ui/settings/usageBudget";

describe("describeBudgetUsage", () => {
	test("reports usage without a bar when there is no limit", () => {
		expect(describeBudgetUsage(12345, 0)).toEqual({
			used: 12345,
			budget: 0,
			percent: null,
			level: "none",
			label: "12,345 tokens used, no limit"
		});
	});

	test("uses the singular for exactly one token", () => {
		expect(describeBudgetUsage(1, 0).label).toBe("1 token used, no limit");
	});

	test("treats a negative budget as no limit", () => {
		const view = describeBudgetUsage(500, -1);
		expect(view.level).toBe("none");
		expect(view.percent).toBeNull();
	});

	test("shows a comfortable level below 80 per cent", () => {
		expect(describeBudgetUsage(12345, 100000)).toEqual({
			used: 12345,
			budget: 100000,
			percent: 12,
			level: "ok",
			label: "12,345 of 100,000 tokens (12%)"
		});
		expect(describeBudgetUsage(0, 100000).level).toBe("ok");
		expect(describeBudgetUsage(79000, 100000).level).toBe("ok");
	});

	test("flags near from 80 per cent up to the budget", () => {
		expect(describeBudgetUsage(80000, 100000).level).toBe("near");
		expect(describeBudgetUsage(99999, 100000).level).toBe("near");
	});

	test("flags over once usage reaches the budget, matching the guardrail's boundary", () => {
		expect(describeBudgetUsage(100000, 100000)).toMatchObject({ level: "over", percent: 100 });
		expect(describeBudgetUsage(125000, 100000)).toMatchObject({
			level: "over",
			percent: 125,
			label: "125,000 of 100,000 tokens (125%, over budget)"
		});
	});

	test("names the near-limit state in the label, not only through colour", () => {
		expect(describeBudgetUsage(85000, 100000).label).toBe("85,000 of 100,000 tokens (85%, near limit)");
	});

	test("rounds the percentage to a whole number", () => {
		expect(describeBudgetUsage(1, 3).percent).toBe(33);
		expect(describeBudgetUsage(2, 3).percent).toBe(67);
	});

	test("treats negative and non-finite usage as zero", () => {
		for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(describeBudgetUsage(bad, 1000)).toMatchObject({
				used: 0,
				percent: 0,
				level: "ok",
				label: "0 of 1,000 tokens (0%)"
			});
		}
	});

	test("treats a non-finite budget as no limit", () => {
		expect(describeBudgetUsage(10, Number.NaN).level).toBe("none");
		expect(describeBudgetUsage(10, Number.POSITIVE_INFINITY).level).toBe("none");
	});

	test("formats numbers with UK thousands separators", () => {
		expect(describeBudgetUsage(1234567, 10000000).label).toBe("1,234,567 of 10,000,000 tokens (12%)");
	});
});

describe("getBudgetFillPercent", () => {
	test("returns 0 when there is no limit", () => {
		expect(getBudgetFillPercent(describeBudgetUsage(500, 0))).toBe(0);
	});

	test("follows the percentage within the budget", () => {
		expect(getBudgetFillPercent(describeBudgetUsage(25000, 100000))).toBe(25);
	});

	test("stops at 100 when usage passes the budget", () => {
		expect(getBudgetFillPercent(describeBudgetUsage(250000, 100000))).toBe(100);
	});
});

describe("describeBudgetEnforcement", () => {
	test("says budgets are not enforced when guardrails are off, whatever the mode", () => {
		const expected = "Guardrails are off, so budgets are not enforced. Turn on Usage budgets and guardrails on the previous page.";
		expect(describeBudgetEnforcement(false, "warn")).toBe(expected);
		expect(describeBudgetEnforcement(false, "block")).toBe(expected);
	});

	test("describes warn and block modes when guardrails are on", () => {
		expect(describeBudgetEnforcement(true, "warn")).toBe("Requests over budget show a warning.");
		expect(describeBudgetEnforcement(true, "block")).toBe("Requests over budget are blocked.");
	});
});
