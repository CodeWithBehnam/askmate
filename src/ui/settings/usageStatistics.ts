import { ButtonComponent, Setting } from "obsidian";
import {
	formatApiEndpoint,
	formatDuration,
	formatOperationKind,
	formatOperationStatus,
	formatOutputMode,
	formatTokenCount,
	formatUsageTimestamp,
	RECENT_TOKEN_BAR_RECORD_LIMIT,
	RECENT_TOKEN_TABLE_RECORD_LIMIT,
	TOKEN_RUN_CHART_RECORD_LIMIT,
	truncateLabel,
	type BudgetEnforcementMode,
	type TokenUsageRecord,
	type TokenUsageSummary
} from "../../shared/core";
import { describeBudgetEnforcement, describeBudgetUsage, getBudgetFillPercent, type BudgetUsageView } from "./usageBudget";

export interface UsageBudgetSnapshot {
	guardrailsEnabled: boolean;
	enforcement: BudgetEnforcementMode;
	dailyUsed: number;
	dailyBudget: number;
	monthlyUsed: number;
	monthlyBudget: number;
}

export interface UsageStatisticsOptions {
	records: TokenUsageRecord[];
	summary: TokenUsageSummary;
	budget: UsageBudgetSnapshot;
	onReset: () => void;
}

export function renderUsageStatistics(containerEl: HTMLElement, options: UsageStatisticsOptions): void {
	const { records, summary, budget, onReset } = options;

	const statsEl = containerEl.createDiv({ cls: "askmate-usage-stats" });
	renderBudgetCard(statsEl, budget);

	const header = statsEl.createDiv({ cls: "askmate-usage-header" });
	const copy = header.createDiv({ cls: "askmate-usage-copy" });
	new Setting(copy).setName("Operation usage").setHeading();
	copy.createEl("p", {
		text: "Tracks AskMate API operations by provider, including text responses, image prompt planning, and image generation. Images API rows may show zero tokens."
	});

	const actions = header.createDiv({ cls: "askmate-usage-actions" });
	new ButtonComponent(actions)
		.setButtonText("Reset statistics")
		.setDestructive()
		.setDisabled(records.length === 0)
		.onClick(() => onReset());

	renderSummaryCards(statsEl, summary);

	if (records.length === 0) {
		statsEl.createDiv({
			cls: "askmate-usage-empty",
			text: "No usage has been recorded yet. Ask a question or run a workflow to populate the charts."
		});
		return;
	}

	const chartGrid = statsEl.createDiv({ cls: "askmate-chart-grid" });
	renderRecentTokenBarChart(chartGrid, records.slice(-RECENT_TOKEN_BAR_RECORD_LIMIT));
	renderTokenRunChart(chartGrid, records.slice(-TOKEN_RUN_CHART_RECORD_LIMIT));
	renderRecentUsageTable(statsEl, records.slice(-RECENT_TOKEN_TABLE_RECORD_LIMIT).reverse());
}

function renderBudgetCard(parent: HTMLElement, budget: UsageBudgetSnapshot): void {
	const card = parent.createDiv({ cls: "askmate-budget-card" });
	new Setting(card).setName("Budgets").setHeading();

	const meters = card.createDiv({ cls: "askmate-budget-meters" });
	renderBudgetMeter(meters, "Today", describeBudgetUsage(budget.dailyUsed, budget.dailyBudget));
	renderBudgetMeter(meters, "This month", describeBudgetUsage(budget.monthlyUsed, budget.monthlyBudget));

	card.createEl("p", {
		cls: "askmate-settings-note askmate-budget-note",
		text: describeBudgetEnforcement(budget.guardrailsEnabled, budget.enforcement)
	});
}

function renderBudgetMeter(parent: HTMLElement, name: string, view: BudgetUsageView): void {
	const meter = parent.createDiv({ cls: "askmate-budget-meter" });
	if (view.level === "near" || view.level === "over") {
		meter.addClass(`is-${view.level}`);
	}

	const head = meter.createDiv({ cls: "askmate-budget-meter-head" });
	head.createSpan({ cls: "askmate-budget-meter-name", text: name });
	head.createSpan({ cls: "askmate-budget-meter-text", text: view.label });

	// With no limit there is nothing to measure against, so only the text is shown.
	if (view.budget <= 0) {
		return;
	}

	const track = meter.createDiv({
		cls: "askmate-budget-track",
		attr: {
			role: "meter",
			"aria-label": `${name} token budget`,
			"aria-valuemin": "0",
			"aria-valuemax": String(view.budget),
			"aria-valuenow": String(Math.min(view.used, view.budget)),
			"aria-valuetext": view.label
		}
	});
	const fill = track.createDiv({ cls: "askmate-budget-fill" });
	fill.setCssProps({ "--askmate-budget-fill": `${getBudgetFillPercent(view)}%` });
}

function renderSummaryCards(parent: HTMLElement, summary: TokenUsageSummary): void {
	const grid = parent.createDiv({ cls: "askmate-stat-grid" });
	createStatCard(grid, "Operations", formatTokenCount(summary.requests), "Recorded AskMate API operations");
	createStatCard(grid, "Sent", formatTokenCount(summary.inputTokens), "Responses API input tokens");
	createStatCard(grid, "Received", formatTokenCount(summary.outputTokens), "Responses API output tokens");
	createStatCard(grid, "Total", formatTokenCount(summary.totalTokens), "Tracked tokens");
	createStatCard(grid, "Average per operation", formatTokenCount(summary.averageTotalTokens), "Tokens per operation");
	createStatCard(grid, "Average time", formatDuration(summary.averageDurationMs), "Operation duration");

	if (summary.completedOperations > 0) {
		createStatCard(grid, "Completed", formatTokenCount(summary.completedOperations), "Completed operations");
	}

	if (summary.failedOperations > 0) {
		createStatCard(grid, "Failed", formatTokenCount(summary.failedOperations), "Failed operations");
	}

	if (summary.abortedOperations > 0) {
		createStatCard(grid, "Aborted", formatTokenCount(summary.abortedOperations), "Stopped operations");
	}

	if (summary.fallbackOperations > 0) {
		createStatCard(grid, "Fallback", formatTokenCount(summary.fallbackOperations), "Operations that used fallback behavior");
	}

	if (summary.imageOperations > 0) {
		createStatCard(grid, "Image operations", formatTokenCount(summary.imageOperations), "Images API generations");
	}

	if (summary.cachedInputTokens > 0) {
		createStatCard(grid, "Cached", formatTokenCount(summary.cachedInputTokens), "Cached input tokens");
	}

	if (summary.reasoningOutputTokens > 0) {
		createStatCard(grid, "Reasoning", formatTokenCount(summary.reasoningOutputTokens), "Reasoning output tokens");
	}

	if (summary.estimatedRecords > 0) {
		createStatCard(grid, "Estimated", formatTokenCount(summary.estimatedRecords), "Operations with estimated or unavailable usage");
	}

	if (summary.lastRecord) {
		createStatCard(grid, "Latest", formatUsageTimestamp(summary.lastRecord.timestamp), truncateLabel(summary.lastRecord.title, 36));
	}
}

function createStatCard(parent: HTMLElement, label: string, value: string, description: string): void {
	const card = parent.createDiv({ cls: "askmate-stat-card" });
	card.createDiv({ cls: "askmate-stat-label", text: label });
	card.createDiv({ cls: "askmate-stat-value", text: value });
	card.createDiv({ cls: "askmate-stat-desc", text: description });
}

function renderRecentTokenBarChart(parent: HTMLElement, records: TokenUsageRecord[]): void {
	const card = createChartCard(
		parent,
		"Recent sent vs received tokens",
		"Stacked bars show input and output tokens for recent operations. Images API rows may be zero."
	);
	renderChartLegend(card, [
		["Sent", "askmate-chart-legend-input"],
		["Received", "askmate-chart-legend-output"]
	]);

	const width = 640;
	const height = 300;
	const margin = { top: 24, right: 20, bottom: 70, left: 62 };
	const bottom = height - margin.bottom;
	const plotWidth = width - margin.left - margin.right;
	const yMax = getNiceChartMax(records.reduce((max, record) => Math.max(max, record.totalTokens, record.inputTokens + record.outputTokens), 1));
	const yScale = (value: number) => bottom - (Math.max(0, value) / yMax) * (bottom - margin.top);
	const svg = createChartSvg(card, width, height, "Recent token mix bar chart");

	renderChartYAxis(svg, margin.left, margin.top, bottom, width - margin.right, yMax, yScale);

	const count = Math.max(1, records.length);
	const step = plotWidth / count;
	const barWidth = Math.max(6, Math.min(34, step * 0.72));
	const labelEvery = Math.max(1, Math.ceil(records.length / 8));
	appendSvgLine(svg, margin.left, bottom, width - margin.right, bottom, "askmate-chart-axis-line");

	records.forEach((record, index) => {
		const x = margin.left + index * step + (step - barWidth) / 2;
		const inputY = yScale(record.inputTokens);
		const totalY = yScale(record.inputTokens + record.outputTokens);
		const inputHeight = Math.max(0, bottom - inputY);
		const outputHeight = Math.max(0, inputY - totalY);

		const inputBar = appendSvgElement(svg, "rect", {
			class: "askmate-chart-bar-input",
			x,
			y: inputY,
			width: barWidth,
			height: inputHeight
		});
		appendSvgTitle(inputBar, formatBarTooltip(record));

		const outputBar = appendSvgElement(svg, "rect", {
			class: "askmate-chart-bar-output",
			x,
			y: totalY,
			width: barWidth,
			height: outputHeight
		});
		appendSvgTitle(outputBar, formatBarTooltip(record));

		if (index % labelEvery === 0 || index === records.length - 1) {
			const label = appendSvgText(svg, x + barWidth / 2, bottom + 18, formatUsageTimestamp(record.timestamp), "askmate-chart-axis-label");
			label.setAttribute("transform", `rotate(-30 ${x + barWidth / 2} ${bottom + 18})`);
			label.setAttribute("text-anchor", "end");
		}
	});
}

function renderTokenRunChart(parent: HTMLElement, records: TokenUsageRecord[]): void {
	type RunChartDatum = {
		record: TokenUsageRecord;
		date: Date;
		totalTokens: number;
	};

	const card = createChartCard(
		parent,
		"Token run chart",
		"Line chart of total tokens per operation over time."
	);
	const data = records
		.map((record): RunChartDatum => ({
			record,
			date: new Date(record.timestamp),
			totalTokens: record.totalTokens
		}))
		.filter((datum) => !Number.isNaN(datum.date.getTime()))
		.sort((a, b) => a.date.getTime() - b.date.getTime());
	const width = 640;
	const height = 300;
	const margin = { top: 24, right: 22, bottom: 58, left: 62 };
	const bottom = height - margin.bottom;
	const firstDate = data[0]?.date ?? new Date();
	const lastDate = data[data.length - 1]?.date ?? firstDate;
	const domainStart = firstDate.getTime() === lastDate.getTime()
		? new Date(firstDate.getTime() - 60 * 60 * 1000)
		: firstDate;
	const domainEnd = firstDate.getTime() === lastDate.getTime()
		? new Date(lastDate.getTime() + 60 * 60 * 1000)
		: lastDate;
	const timeSpan = Math.max(1, domainEnd.getTime() - domainStart.getTime());
	const yMax = getNiceChartMax(data.reduce((max, datum) => Math.max(max, datum.totalTokens), 1));
	const xScale = (date: Date) => margin.left + ((date.getTime() - domainStart.getTime()) / timeSpan) * (width - margin.left - margin.right);
	const yScale = (value: number) => bottom - (Math.max(0, value) / yMax) * (bottom - margin.top);
	const svg = createChartSvg(card, width, height, "Token run chart");
	const average = data.length > 0
		? data.reduce((sum, datum) => sum + datum.totalTokens, 0) / data.length
		: 0;

	renderChartYAxis(svg, margin.left, margin.top, bottom, width - margin.right, yMax, yScale);
	appendSvgLine(svg, margin.left, bottom, width - margin.right, bottom, "askmate-chart-axis-line");
	renderTimeAxisLabels(svg, domainStart, domainEnd, margin.left, width - margin.right, bottom);
	appendSvgLine(svg, margin.left, yScale(average), width - margin.right, yScale(average), "askmate-chart-average");

	if (data.length > 0) {
		appendSvgElement(svg, "path", {
			class: "askmate-chart-line",
			d: data.map((datum, index) => `${index === 0 ? "M" : "L"}${xScale(datum.date).toFixed(2)},${yScale(datum.totalTokens).toFixed(2)}`).join(" ")
		});
	}

	for (const datum of data) {
		const dot = appendSvgElement(svg, "circle", {
			class: "askmate-chart-dot",
			cx: xScale(datum.date),
			cy: yScale(datum.totalTokens),
			r: 4
		});
		appendSvgTitle(dot, [
			`${datum.record.title} (${formatUsageTimestamp(datum.record.timestamp)})`,
			`Operation: ${formatOperationKind(datum.record.operationKind)}`,
			`Status: ${formatOperationStatus(datum.record.status)}`,
			`Total: ${formatTokenCount(datum.record.totalTokens)}`,
			`Duration: ${formatDuration(datum.record.durationMs)}`
		].join("\n"));
	}
}

function renderRecentUsageTable(parent: HTMLElement, records: TokenUsageRecord[]): void {
	const card = parent.createDiv({ cls: "askmate-usage-table-card" });
	new Setting(card).setName("Recent operations").setHeading();
	const wrapper = card.createDiv({ cls: "askmate-usage-table-wrapper" });
	const table = wrapper.createEl("table", { cls: "askmate-usage-table" });
	const thead = table.createEl("thead");
	const headerRow = thead.createEl("tr");

	for (const heading of ["Time", "Task", "Operation", "Status", "Provider", "Endpoint", "Output", "Model", "Sent", "Received", "Total", "Duration", "Source", "Usage"] as const) {
		headerRow.createEl("th", { text: heading });
	}

	const tbody = table.createEl("tbody");

	for (const record of records) {
		const row = tbody.createEl("tr");
		row.createEl("td", { text: formatUsageTimestamp(record.timestamp) });
		row.createEl("td", { text: truncateLabel(record.title, 30) });
		row.createEl("td", { text: formatOperationKind(record.operationKind) });
		const statusCell = row.createEl("td", { text: formatOperationStatus(record.status) });
		if (record.errorMessage) {
			statusCell.setAttribute("title", record.errorMessage);
		}
		row.createEl("td", { text: truncateLabel(record.providerName, 20) });
		row.createEl("td", { text: formatApiEndpoint(record.endpoint) });
		row.createEl("td", { text: formatOutputMode(record.outputMode) });
		row.createEl("td", { text: truncateLabel(record.model, 24) });
		row.createEl("td", { text: formatTokenCount(record.inputTokens) });
		row.createEl("td", { text: formatTokenCount(record.outputTokens) });
		row.createEl("td", { text: formatTokenCount(record.totalTokens) });
		row.createEl("td", { text: formatDuration(record.durationMs) });
		const sourceLabel = record.sourcePath
			? `${record.contextSource}: ${truncateLabel(record.sourcePath, 38)}`
			: record.contextSource;
		const sourceCell = row.createEl("td", { text: sourceLabel });
		sourceCell.setAttribute("title", record.sourcePath || record.contextSource);
		row.createEl("td", { text: record.estimated ? "Estimated" : "API" });
	}
}

function createChartCard(parent: HTMLElement, title: string, description: string): HTMLElement {
	const card = parent.createDiv({ cls: "askmate-chart-card" });
	new Setting(card).setName(title).setHeading();
	card.createEl("p", { text: description });
	return card;
}

function createChartSvg(parent: HTMLElement, width: number, height: number, label: string): SVGSVGElement {
	const svg = parent.createSvg("svg");
	const id = `askmate-chart-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
	svg.setAttribute("class", "askmate-chart-svg");
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-labelledby", `${id}-title ${id}-desc`);
	const title = svg.createSvg("title");
	title.id = `${id}-title`;
	title.textContent = label;
	const description = svg.createSvg("desc");
	description.id = `${id}-desc`;
	description.textContent = `${label}. Detailed operation data is available in the recent operations table below.`;
	return svg;
}

function appendSvgElement<K extends keyof SVGElementTagNameMap>(
	parent: SVGElement,
	tagName: K,
	attributes: Record<string, string | number>
): SVGElementTagNameMap[K] {
	const element = parent.createSvg(tagName);
	for (const [key, value] of Object.entries(attributes)) {
		element.setAttribute(key, String(value));
	}
	return element;
}

function appendSvgLine(parent: SVGElement, x1: number, y1: number, x2: number, y2: number, className: string): SVGLineElement {
	return appendSvgElement(parent, "line", {
		class: className,
		x1,
		y1,
		x2,
		y2
	});
}

function appendSvgText(parent: SVGElement, x: number, y: number, text: string, className: string): SVGTextElement {
	const element = appendSvgElement(parent, "text", {
		class: className,
		x,
		y
	});
	element.textContent = text;
	return element;
}

function appendSvgTitle(parent: SVGElement, text: string): void {
	parent.createSvg("title").textContent = text;
}

function renderChartYAxis(
	svg: SVGSVGElement,
	x: number,
	top: number,
	bottom: number,
	right: number,
	yMax: number,
	yScale: (value: number) => number
): void {
	appendSvgLine(svg, x, top, x, bottom, "askmate-chart-axis-line");
	for (let index = 0; index <= 4; index += 1) {
		const value = Math.round((yMax / 4) * index);
		const y = yScale(value);
		appendSvgLine(svg, x - 4, y, right, y, index === 0 ? "askmate-chart-grid-line askmate-chart-grid-line-base" : "askmate-chart-grid-line");
		const label = appendSvgText(svg, x - 8, y + 4, formatTokenCount(value), "askmate-chart-axis-label");
		label.setAttribute("text-anchor", "end");
	}
}

function renderTimeAxisLabels(svg: SVGSVGElement, start: Date, end: Date, left: number, right: number, bottom: number): void {
	for (let index = 0; index <= 4; index += 1) {
		const ratio = index / 4;
		const x = left + (right - left) * ratio;
		const date = new Date(start.getTime() + (end.getTime() - start.getTime()) * ratio);
		const label = appendSvgText(svg, x, bottom + 22, formatUsageTimestamp(date.toISOString()), "askmate-chart-axis-label");
		label.setAttribute("text-anchor", index === 0 ? "start" : index === 4 ? "end" : "middle");
	}
}

function getNiceChartMax(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return 1;
	}

	const exponent = Math.floor(Math.log10(value));
	const base = 10 ** exponent;
	const normalized = value / base;
	const niceNormalized = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
	return niceNormalized * base;
}

function formatBarTooltip(record: TokenUsageRecord): string {
	return [
		`${record.title} (${formatUsageTimestamp(record.timestamp)})`,
		`Operation: ${formatOperationKind(record.operationKind)}`,
		`Status: ${formatOperationStatus(record.status)}`,
		`Sent: ${formatTokenCount(record.inputTokens)}`,
		`Received: ${formatTokenCount(record.outputTokens)}`,
		`Total: ${formatTokenCount(record.totalTokens)}`,
		record.estimated ? "Usage is estimated or unavailable" : "Usage is from the API"
	].join("\n");
}

function renderChartLegend(parent: HTMLElement, items: Array<[string, string]>): void {
	const legend = parent.createDiv({ cls: "askmate-chart-legend" });

	for (const [label, swatchClass] of items) {
		const item = legend.createDiv({ cls: "askmate-chart-legend-item" });
		item.createSpan({ cls: `askmate-chart-legend-swatch ${swatchClass}` });
		item.createSpan({ text: label });
	}
}
