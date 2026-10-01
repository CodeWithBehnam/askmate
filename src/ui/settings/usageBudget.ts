import type { BudgetEnforcementMode } from "../../shared/types";

/** Kept pure and free of Obsidian imports so the thresholds and wording can be tested without a DOM. */
export type BudgetLevel = "none" | "ok" | "near" | "over";

export interface BudgetUsageView {
	/** Used tokens after treating negative or non-finite input as 0. */
	used: number;
	/** Budget in tokens after the same clean-up. 0 means no limit. */
	budget: number;
	/** Whole-number percentage of the budget used, which may exceed 100. Null when there is no limit. */
	percent: number | null;
	level: BudgetLevel;
	label: string;
}

const NEAR_BUDGET_PERCENT = 80;

function toTokenCount(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatCount(value: number): string {
	return value.toLocaleString("en-GB", { maximumFractionDigits: 0 });
}

export function describeBudgetUsage(used: number, budget: number): BudgetUsageView {
	const safeUsed = toTokenCount(used);
	const safeBudget = toTokenCount(budget);

	if (safeBudget === 0) {
		return {
			used: safeUsed,
			budget: 0,
			percent: null,
			level: "none",
			label: `${formatCount(safeUsed)} ${safeUsed === 1 ? "token" : "tokens"} used, no limit`
		};
	}

	const percent = Math.round((safeUsed / safeBudget) * 100);
	const level: BudgetLevel = safeUsed >= safeBudget ? "over" : percent >= NEAR_BUDGET_PERCENT ? "near" : "ok";
	// The meter colour is not the only signal: the label, which is also the meter's aria-valuetext, names the state.
	const state = level === "over" ? ", over budget" : level === "near" ? ", near limit" : "";

	return {
		used: safeUsed,
		budget: safeBudget,
		percent,
		level,
		label: `${formatCount(safeUsed)} of ${formatCount(safeBudget)} tokens (${percent}%${state})`
	};
}

/** The bar stops at full width when usage passes the budget, because the label carries the overshoot. */
export function getBudgetFillPercent(view: BudgetUsageView): number {
	return view.percent === null ? 0 : Math.min(100, Math.max(0, view.percent));
}

export function describeBudgetEnforcement(guardrailsEnabled: boolean, enforcement: BudgetEnforcementMode): string {
	if (!guardrailsEnabled) {
		return "Guardrails are off, so budgets are not enforced. Turn on Usage budgets and guardrails on the previous page.";
	}

	switch (enforcement) {
		case "warn":
			return "Requests over budget show a warning.";
		case "block":
			return "Requests over budget are blocked.";
		default: {
			const unhandled: never = enforcement;
			throw new Error(`Unhandled budget enforcement mode: ${String(unhandled)}`);
		}
	}
}
