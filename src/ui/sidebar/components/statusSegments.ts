import type { McpServerState, McpServerStatus } from "../../../mcp";
import type { SetupStage } from "../../../setup";
import { describeSetupStage, isReadyToSend } from "../../../setup";
import type { ConsoleStatusSegment } from "../consoleCommands";

/**
 * The status line under the Console composer. The segments are fixed in number and order and are updated in place, so a
 * button that has keyboard focus is never replaced while the line refreshes (it refreshes on every click and focus).
 */

export type SegmentKind = "mode" | "model" | "effort" | "usage" | "setup" | "skills" | "mcp";
export type SegmentTone = "ready" | "warning" | "error" | "off" | "busy";

export interface SegmentState {
	kind: SegmentKind;
	text: string;
	title: string;
	hidden: boolean;
	tone: SegmentTone | null;
	/** Segments that are buttons. */
	disabled: boolean;
}

export const SEGMENT_ORDER: readonly SegmentKind[] = ["mode", "setup", "model", "effort", "usage", "skills", "mcp"];
export const INTERACTIVE_SEGMENTS: ReadonlySet<SegmentKind> = new Set<SegmentKind>(["mode", "model", "setup"]);

export interface StatusInput {
	console: readonly ConsoleStatusSegment[];
	stage: SetupStage;
	/** Skills kept on for this conversation. */
	stickySkills: number;
	mcp: readonly McpServerStatus[] | null;
	busy: boolean;
}

export interface McpSummary {
	text: string;
	title: string;
	tone: SegmentTone;
}

function describeMcpState(state: McpServerState): string {
	switch (state.kind) {
		case "off":
			return "off";
		case "needs-trust":
			return "needs your trust (open settings, then Skills and tools, to review it)";
		case "idle":
			return "ready, starts when first used";
		case "connecting":
			return "connecting";
		case "ready":
			return `ready, ${state.tools} ${state.tools === 1 ? "tool" : "tools"}${state.hidden > 0 ? `, ${state.hidden} hidden` : ""}`;
		case "needs-auth":
			return `needs sign-in${state.hint ? `: ${state.hint}` : ""}`;
		case "error":
			return `${state.message}${state.fix ? ` ${state.fix}` : ""}`;
	}
}

/** One line per server for /mcp. */
export function formatMcpStatus(statuses: readonly McpServerStatus[] | null | undefined): string {
	if (!statuses || statuses.length === 0) {
		return [
			"No tool servers are set up.",
			"Tools are off by default. To add a server, open settings, then Skills and tools.",
			"AskMate asks before every tool call unless you change that."
		].join("\n");
	}
	const width = Math.max(...statuses.map((status) => status.label.length)) + 2;
	return [
		"Tool servers",
		...statuses.map((status) => `  ${status.label.padEnd(width)}${status.transport.padEnd(7)}${describeMcpState(status.state)}`),
		"",
		"AskMate asks before each tool call and shows exactly what will be sent."
	].join("\n");
}

/** The status line segment for tools, or null when no server is on and there is nothing to say. */
export function summariseMcp(statuses: readonly McpServerStatus[] | null | undefined): McpSummary | null {
	const active = (statuses ?? []).filter((status) => status.state.kind !== "off");
	if (active.length === 0) {
		return null;
	}
	const states = active.map((status) => status.state);
	if (states.some((state) => state.kind === "error")) {
		return { text: "tools: error", title: "A tool server has a problem. Type /mcp for details.", tone: "error" };
	}
	if (states.some((state) => state.kind === "needs-trust" || state.kind === "needs-auth")) {
		return { text: "tools: review", title: "A tool server needs your attention. Type /mcp for details.", tone: "warning" };
	}
	if (states.some((state) => state.kind === "connecting")) {
		return { text: "tools: connecting", title: "A tool server is starting.", tone: "busy" };
	}
	const tools = states.reduce((total, state) => total + (state.kind === "ready" ? state.tools : 0), 0);
	return tools > 0
		? { text: `tools ${tools}`, title: `${tools} ${tools === 1 ? "tool is" : "tools are"} available. AskMate asks before each call.`, tone: "ready" }
		: { text: "tools on", title: "Tool servers start when first used. AskMate asks before each call.", tone: "ready" };
}

export function buildStatusSegments(input: StatusInput): SegmentState[] {
	const byKind = new Map(input.console.map((segment) => [segment.kind, segment]));
	const setup = describeSetupStage(input.stage);
	const needsSetup = !isReadyToSend(input.stage) || input.stage.kind === "test-failed";
	const mcp = summariseMcp(input.mcp);
	const from = (kind: "mode" | "model" | "effort" | "usage"): SegmentState => {
		const segment = byKind.get(kind);
		return {
			kind,
			text: segment?.text ?? "",
			title: kind === "model" && segment ? `${segment.title}. Click to switch model or provider.` : segment?.title ?? "",
			hidden: !segment,
			tone: null,
			disabled: input.busy && (kind === "mode" || kind === "model")
		};
	};
	return [
		from("mode"),
		{
			kind: "setup",
			text: input.stage.kind === "test-failed" ? "Connection failed" : "Not connected",
			title: `${setup.headline}. Click to set up.`,
			hidden: !needsSetup,
			tone: !needsSetup ? null : input.stage.kind === "test-failed" ? "error" : "warning",
			disabled: false
		},
		from("model"),
		from("effort"),
		from("usage"),
		{
			kind: "skills",
			text: input.stickySkills === 1 ? "1 skill" : `${input.stickySkills} skills`,
			title: "Skills kept on for this conversation. Type /skills to see them.",
			hidden: input.stickySkills === 0,
			tone: null,
			disabled: false
		},
		{
			kind: "mcp",
			text: mcp?.text ?? "",
			title: mcp?.title ?? "",
			hidden: mcp === null,
			tone: mcp?.tone ?? null,
			disabled: false
		}
	];
}

export interface StatusCallbacks {
	onMode: () => void;
	onModel: () => void;
	onSetup: () => void;
}

export interface StatusSegmentsHandle {
	update(states: readonly SegmentState[]): void;
	/** The mode button, kept by the view for tests and focus. */
	buttons: Readonly<Partial<Record<SegmentKind, HTMLButtonElement>>>;
}

const TONES: readonly SegmentTone[] = ["ready", "warning", "error", "off", "busy"];

/** Builds every segment once, in order. `update` only changes text, title, tone and visibility. */
export function createStatusSegments(container: HTMLElement, callbacks: StatusCallbacks): StatusSegmentsHandle {
	const elements = new Map<SegmentKind, HTMLElement>();
	const buttons: Partial<Record<SegmentKind, HTMLButtonElement>> = {};
	const handlers: Partial<Record<SegmentKind, () => void>> = { mode: callbacks.onMode, model: callbacks.onModel, setup: callbacks.onSetup };
	for (const kind of SEGMENT_ORDER) {
		const classes = `askmate-console-segment is-${kind}`;
		if (INTERACTIVE_SEGMENTS.has(kind)) {
			const button = container.createEl("button", { cls: classes });
			button.type = "button";
			button.addEventListener("click", () => handlers[kind]?.());
			elements.set(kind, button);
			buttons[kind] = button;
		} else {
			elements.set(kind, container.createSpan({ cls: classes }));
		}
	}
	return {
		buttons,
		update(states) {
			for (const state of states) {
				const el = elements.get(state.kind);
				if (!el) {
					continue;
				}
				// A segment that is hidden holds no text either, so nothing shows if a style sheet ignores the attribute.
				const text = state.hidden ? "" : state.text;
				if (el.textContent !== text) {
					el.setText(text);
				}
				el.hidden = state.hidden;
				el.setAttribute("title", state.title);
				if (INTERACTIVE_SEGMENTS.has(state.kind)) {
					el.setAttribute("aria-label", state.title);
					(el as HTMLButtonElement).disabled = state.disabled;
				}
				el.classList.toggle("askmate-status-chip", state.tone !== null);
				for (const tone of TONES) {
					el.classList.toggle(`is-${tone}`, state.tone === tone);
				}
			}
		}
	};
}
