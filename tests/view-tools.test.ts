import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { McpServerStatus } from "../src/mcp";
import { createToolCallCard, renderSavedToolCalls } from "../src/ui/sidebar/components/ToolCallCard";
import type { ToolApprovalRequest, ToolUiEvent } from "../src/ui/sidebar/components/pluginApi";
import {
	buildStatusSegments,
	createStatusSegments,
	formatMcpStatus,
	summariseMcp,
	type StatusInput
} from "../src/ui/sidebar/components/statusSegments";
import {
	approvalCardName,
	describeSavedToolCall,
	formatToolArguments,
	isFinalToolStatus,
	MAX_RESULT_PREVIEW_CHARACTERS,
	mergeToolEvent,
	previewToolResult,
	showHiddenCharacters,
	summariseToolCalls,
	toolCardName,
	toolStatusText
} from "../src/ui/sidebar/components/toolModel";
import { deriveProviderSetupState } from "../src/setup";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { createFakeEl, installDomGlobals } from "./support/fake-dom";

const event = (patch: Partial<ToolUiEvent> = {}): ToolUiEvent => ({ id: "call-1", server: "Notes", tool: "search", status: "running", argumentsJson: "{\"query\":\"plan\"}", ...patch });
const approval: ToolApprovalRequest = { id: "call-1", server: "Notes", tool: "search", argumentsJson: "{\"query\":\"plan\",\"limit\":5}", changedSinceApproval: false };

describe("tool call model", () => {
	test("says what each status means in plain words", () => {
		expect(toolStatusText("pending-approval")).toBe("Waiting for your approval");
		expect(toolStatusText("error")).toBe("Failed");
		expect(toolCardName(event())).toBe("Notes: search");
		expect(toolCardName(event({ server: "" }))).toBe("search");
	});

	test("shows the arguments exactly, pretty printed, and never shortens them", () => {
		expect(formatToolArguments("{\"a\":1}")).toBe("{\n  \"a\": 1\n}");
		expect(formatToolArguments("not json {")).toBe("not json {");
		expect(formatToolArguments("")).toBe("{}");
		const long = JSON.stringify({ text: "x".repeat(5000) });
		expect(formatToolArguments(long)).toContain("x".repeat(5000));
	});

	test("hidden characters are written as visible \\uXXXX sequences, and nothing else changes", () => {
		expect(showHiddenCharacters("a\u202Eb\u200Bc\u2066d\u2069e\uFEFF")).toBe("a\\u202Eb\\u200Bc\\u2066d\\u2069e\\uFEFF");
		expect(showHiddenCharacters("tag\u{E0041}")).toBe("tag\\u{E0041}");
		expect(showHiddenCharacters("bell\u0007 nul\u0000 del\u007F")).toBe("bell\\u0007 nul\\u0000 del\\u007F");
		expect(showHiddenCharacters("line\u2028sep")).toBe("line\\u2028sep");
		const plain = "plain, é中😀 text\nnext\tline\r\n";
		expect(showHiddenCharacters(plain)).toBe(plain);
	});

	test("arguments keep every character and show the hidden ones, in JSON and in text that is not JSON", () => {
		const shown = formatToolArguments(JSON.stringify({ path: "notes/\u202Etxt.exe", cmd: "ls\u2066 -la", z: "a\u200Bb" }));
		expect(shown).toBe("{\n  \"path\": \"notes/\\u202Etxt.exe\",\n  \"cmd\": \"ls\\u2066 -la\",\n  \"z\": \"a\\u200Bb\"\n}");
		expect(formatToolArguments("not json \u202E{")).toBe("not json \\u202E{");
		const long = JSON.stringify({ text: `\u200B${"x".repeat(5000)}` });
		expect(formatToolArguments(long)).toContain("x".repeat(5000));
	});

	test("the approval header names the title and the tool, with the title on one line", () => {
		expect(approvalCardName({ server: "Notes", tool: "search", title: "  Search\n notes " })).toBe("Notes: Search notes (search)");
		expect(approvalCardName({ server: "Notes", tool: "search" })).toBe("Notes: search");
		expect(approvalCardName({ server: "Notes", tool: "search", title: "search" })).toBe("Notes: search");
		expect(approvalCardName({ server: "", tool: "search", title: "Find" })).toBe("Find (search)");
		expect(approvalCardName({ server: "N\u202Eotes", tool: "se\u200Barch" })).toBe("N\\u202Eotes: se\\u200Barch");
	});

	test("names of running and saved calls show hidden characters too", () => {
		expect(toolCardName(event({ server: "Not\u200Bes", tool: "se\u202Earch" }))).toBe("Not\\u200Bes: se\\u202Earch");
		expect(describeSavedToolCall({ server: "N", tool: "t\u202E", status: "completed" })).toBe("N: t\\u202E used");
	});

	test("a result preview is short plain text", () => {
		expect(previewToolResult("  hello \r\n world ")).toBe("hello \n world");
		const preview = previewToolResult("y".repeat(MAX_RESULT_PREVIEW_CHARACTERS + 50));
		expect(preview.length).toBeLessThanOrEqual(MAX_RESULT_PREVIEW_CHARACTERS + 3);
		expect(preview.endsWith("...")).toBe(true);
	});

	test("updates merge by id in the order calls first appeared, and a final status is not undone", () => {
		let calls: ToolUiEvent[] = [];
		calls = mergeToolEvent(calls, event({ id: "a", status: "running" }));
		calls = mergeToolEvent(calls, event({ id: "b", status: "pending-approval" }));
		calls = mergeToolEvent(calls, event({ id: "a", status: "done", resultPreview: "3 notes" }));
		calls = mergeToolEvent(calls, event({ id: "a", status: "running" }));
		expect(calls.map((call) => [call.id, call.status])).toEqual([["a", "done"], ["b", "pending-approval"]]);
		expect(calls[0]?.resultPreview).toBe("3 notes");
		expect(isFinalToolStatus("denied")).toBe(true);
		expect(isFinalToolStatus("running")).toBe(false);
	});

	test("a saved conversation keeps names, outcome and one line, never the arguments", () => {
		const saved = summariseToolCalls([
			event({ id: "a", status: "done", resultPreview: "Found\n3 notes" }),
			event({ id: "b", status: "error", error: "Server closed the connection" }),
			event({ id: "c", status: "denied" }),
			event({ id: "d", status: "running" })
		]);
		expect(saved).toEqual([
			{ server: "Notes", tool: "search", status: "completed", summary: "Found 3 notes" },
			{ server: "Notes", tool: "search", status: "failed", summary: "Server closed the connection" },
			{ server: "Notes", tool: "search", status: "denied" },
			{ server: "Notes", tool: "search", status: "failed" }
		]);
		expect(JSON.stringify(saved)).not.toContain("plan");
		expect(describeSavedToolCall(saved[2]!)).toBe("Notes: search was denied");
	});
});

describe("tool call card", () => {
	let restore: () => void;
	beforeAll(() => {
		restore = installDomGlobals();
	});
	afterAll(() => restore());

	test("draws a card with the contract classes for the current status", () => {
		const parent = createFakeEl();
		const handle = createToolCallCard(parent, event());
		const card = parent.querySelector(".askmate-tool-card");
		expect(card).toBe(handle.el);
		expect(card?.classList.contains("is-running")).toBe(true);
		expect(parent.querySelector(".askmate-tool-card-header")?.textContent).toContain("Notes: search");
		expect(parent.querySelector(".askmate-tool-args")?.textContent).toContain("\"query\": \"plan\"");
		expect(card?.getAttribute("aria-label")).toBe("Tool call Notes: search: Running");
		handle.update(event({ status: "done", resultPreview: "3 notes found" }));
		expect(card?.classList.contains("is-done")).toBe(true);
		expect(card?.classList.contains("is-running")).toBe(false);
		expect(parent.querySelector(".askmate-tool-result")?.textContent).toBe("3 notes found");
	});

	test("approval shows the full arguments and three choices, and resolves with the one pressed", async () => {
		const parent = createFakeEl();
		const handle = createToolCallCard(parent, event({ status: "pending-approval" }));
		const choice = handle.requestApproval(approval, { canAllowForChat: true });
		const buttons = Array.from(parent.querySelectorAll<HTMLButtonElement>(".askmate-tool-approval-actions button"));
		expect(buttons.map((button) => button.textContent)).toEqual(["Allow once", "Allow for this chat", "Deny"]);
		expect(handle.el.classList.contains("is-pending")).toBe(true);
		expect(parent.querySelector(".askmate-tool-args")?.textContent).toContain("\"limit\": 5");
		expect(parent.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
		buttons[1]?.click();
		expect(await choice).toBe("allow-chat");
		expect(parent.querySelector(".askmate-tool-approval-actions")?.children).toHaveLength(0);
	});

	test("without a chat to scope to, Allow for this chat is not offered", async () => {
		const parent = createFakeEl();
		const handle = createToolCallCard(parent, event({ status: "pending-approval" }));
		const choice = handle.requestApproval(approval, { canAllowForChat: false });
		const labels = Array.from(parent.querySelectorAll(".askmate-tool-approval-actions button"), (button) => button.textContent);
		expect(labels).toEqual(["Allow once", "Deny"]);
		parent.querySelectorAll<HTMLButtonElement>(".askmate-tool-approval-actions button")[1]?.click();
		expect(await choice).toBe("deny");
	});

	test("stopping the run denies a call that is waiting", async () => {
		const parent = createFakeEl();
		const handle = createToolCallCard(parent, event({ status: "pending-approval" }));
		const choice = handle.requestApproval(approval, { canAllowForChat: true });
		handle.cancelApproval();
		expect(await choice).toBe("deny");
	});

	test("a final event while waiting also denies, so a promise never hangs", async () => {
		const parent = createFakeEl();
		const handle = createToolCallCard(parent, event({ status: "pending-approval" }));
		const choice = handle.requestApproval(approval, { canAllowForChat: true });
		handle.update(event({ status: "denied" }));
		expect(await choice).toBe("deny");
	});

	test("a tool that changed since it was approved is flagged", () => {
		const parent = createFakeEl();
		const handle = createToolCallCard(parent, event({ status: "pending-approval" }));
		void handle.requestApproval({ ...approval, changedSinceApproval: true, description: "Searches notes", title: "Search notes" }, { canAllowForChat: true });
		expect(parent.querySelector(".askmate-tool-warning")?.textContent).toContain("changed since you last approved");
		expect(parent.querySelector(".askmate-tool-card-desc")?.textContent).toBe("Searches notes");
		// The title never replaces the name of the tool that will run.
		expect(parent.querySelector(".askmate-tool-card-name")?.textContent).toBe("Notes: Search notes (search)");
	});

	test("a server cannot make an approval look like another tool: the real name is always in the header", () => {
		const parent = createFakeEl();
		const handle = createToolCallCard(parent, event({ status: "pending-approval", tool: "delete_all" }));
		void handle.requestApproval({ ...approval, tool: "delete_all", title: "Read a note" }, { canAllowForChat: false });
		expect(parent.querySelector(".askmate-tool-card-name")?.textContent).toBe("Notes: Read a note (delete_all)");
	});

	test("the approval card shows hidden characters in the header, the description and every argument", () => {
		const parent = createFakeEl();
		const handle = createToolCallCard(parent, event({ status: "pending-approval" }));
		const args = JSON.stringify({ path: "notes/\u202Etxt.exe", note: "a\u200Bb", cmd: "ls\u2066 -la" });
		void handle.requestApproval(
			{ ...approval, argumentsJson: args, title: "Safe\u202E title", description: "Reads\u200B a note" },
			{ canAllowForChat: false }
		);
		const name = parent.querySelector(".askmate-tool-card-name")?.textContent ?? "";
		const description = parent.querySelector(".askmate-tool-card-desc")?.textContent ?? "";
		const shownArgs = parent.querySelector(".askmate-tool-args")?.textContent ?? "";
		for (const hidden of ["\u202E", "\u200B", "\u2066"]) {
			expect(`${name}${description}${shownArgs}`).not.toContain(hidden);
		}
		expect(name).toBe("Notes: Safe\\u202E title (search)");
		expect(description).toBe("Reads\\u200B a note");
		expect(shownArgs).toContain("notes/\\u202Etxt.exe");
		expect(shownArgs).toContain("a\\u200Bb");
		expect(shownArgs).toContain("ls\\u2066 -la");
	});

	test("tool text is only ever text", () => {
		const parent = createFakeEl();
		const handle = createToolCallCard(parent, event());
		handle.update(event({ status: "done", resultPreview: "<img src=x onerror=alert(1)> **bold**" }));
		expect(parent.querySelector(".askmate-tool-result img")).toBeNull();
		expect(parent.querySelector(".askmate-tool-result")?.textContent).toContain("<img");
	});

	test("a saved reply lists its calls as a read-only list", () => {
		const parent = createFakeEl();
		renderSavedToolCalls(parent, [{ server: "Notes", tool: "search", status: "completed", summary: "3 notes" }, { server: "Notes", tool: "write", status: "denied" }]);
		const items = parent.querySelectorAll(".askmate-tool-card");
		expect(items).toHaveLength(2);
		expect(items[0]?.textContent).toBe("Notes: search used: 3 notes");
		expect(items[1]?.classList.contains("is-denied")).toBe(true);
		expect(renderSavedToolCalls(createFakeEl(), [])).toBeNull();
	});
});

function server(id: string, state: McpServerStatus["state"]): McpServerStatus {
	return { id, label: id, transport: "http", state };
}

describe("tool servers on the status line", () => {
	const ready = (tools: number): McpServerStatus["state"] => ({ kind: "ready", tools, hidden: 0, era: "2025-11-25" as never, version: "1", serverName: "S" });

	test("nothing is shown while every server is off", () => {
		expect(summariseMcp(null)).toBeNull();
		expect(summariseMcp([])).toBeNull();
		expect(summariseMcp([server("a", { kind: "off" })])).toBeNull();
	});

	test("shows the number of tools when servers are ready, and the most urgent problem otherwise", () => {
		expect(summariseMcp([server("a", ready(3)), server("b", ready(2))])).toMatchObject({ text: "tools 5", tone: "ready" });
		expect(summariseMcp([server("a", { kind: "idle" })])).toMatchObject({ text: "tools on", tone: "ready" });
		expect(summariseMcp([server("a", ready(3)), server("b", { kind: "needs-trust" })])).toMatchObject({ text: "tools: review", tone: "warning" });
		expect(summariseMcp([server("a", { kind: "connecting" })])).toMatchObject({ tone: "busy" });
		expect(summariseMcp([server("a", { kind: "needs-trust" }), server("b", { kind: "error", error: "network" as never, message: "Refused", fix: null })])).toMatchObject({ text: "tools: error", tone: "error" });
	});

	test("/mcp lists each server with plain wording and a fix", () => {
		expect(formatMcpStatus([])).toContain("Tools are off by default");
		const text = formatMcpStatus([
			server("files", ready(4)),
			server("wiki", { kind: "needs-trust" }),
			server("api", { kind: "error", error: "network" as never, message: "Could not reach api.example.com.", fix: "Check the address." })
		]);
		expect(text).toContain("files");
		expect(text).toContain("ready, 4 tools");
		expect(text).toContain("needs your trust");
		expect(text).toContain("Could not reach api.example.com. Check the address.");
		expect(text).toContain("asks before each tool call");
	});
});

describe("status segments", () => {
	let restore: () => void;
	beforeAll(() => {
		restore = installDomGlobals();
	});
	afterAll(() => restore());

	const readyStage = deriveProviderSetupState("openai", { ...structuredClone(DEFAULT_SETTINGS), providers: { ...DEFAULT_SETTINGS.providers, openai: { ...DEFAULT_SETTINGS.providers.openai, apiKeySecretName: "k" } } }, () => true, {
		status: "ok",
		providerId: "openai",
		model: DEFAULT_SETTINGS.providers.openai.model
	});
	const needsKey = deriveProviderSetupState("openai", structuredClone(DEFAULT_SETTINGS), () => true);
	const base = (patch: Partial<StatusInput> = {}): StatusInput => ({
		console: [
			{ kind: "mode", text: "CHAT", title: "Output mode: chat. Click to change." },
			{ kind: "model", text: "gpt-5.5", title: "OpenAI: gpt-5.5" },
			{ kind: "usage", text: "today 1.2k", title: "1,200 tokens used today" }
		],
		stage: readyStage,
		stickySkills: 0,
		mcp: null,
		busy: false,
		...patch
	});

	test("the not connected segment appears only until the provider is set up", () => {
		const hidden = buildStatusSegments(base()).find((segment) => segment.kind === "setup");
		expect(hidden?.hidden).toBe(true);
		const shown = buildStatusSegments(base({ stage: needsKey })).find((segment) => segment.kind === "setup");
		expect(shown).toMatchObject({ hidden: false, text: "Not connected", tone: "warning" });
		expect(shown?.title).toContain("Click to set up");
	});

	test("segments keep their order and hide what has nothing to say", () => {
		const segments = buildStatusSegments(base({ stickySkills: 2 }));
		expect(segments.map((segment) => segment.kind)).toEqual(["mode", "setup", "model", "effort", "usage", "skills", "mcp"]);
		expect(segments.find((segment) => segment.kind === "effort")?.hidden).toBe(true);
		expect(segments.find((segment) => segment.kind === "skills")).toMatchObject({ hidden: false, text: "2 skills" });
		expect(segments.find((segment) => segment.kind === "mcp")?.hidden).toBe(true);
	});

	test("mode and model buttons are disabled while a request runs", () => {
		const segments = buildStatusSegments(base({ busy: true }));
		expect(segments.find((segment) => segment.kind === "mode")?.disabled).toBe(true);
		expect(segments.find((segment) => segment.kind === "model")?.disabled).toBe(true);
		expect(segments.find((segment) => segment.kind === "setup")?.disabled).toBe(false);
	});

	test("updating in place keeps the same elements, so a focused button is never replaced", () => {
		const container = createFakeEl();
		// Focus only exists for elements in the document.
		activeDocument.body.appendChild(container);
		const log: string[] = [];
		const handle = createStatusSegments(container, { onMode: () => log.push("mode"), onModel: () => log.push("model"), onSetup: () => log.push("setup") });
		handle.update(buildStatusSegments(base()));
		const modelButton = container.querySelector<HTMLButtonElement>(".is-model");
		const modeButton = container.querySelector<HTMLButtonElement>(".is-mode");
		modelButton?.focus();
		const before = Array.from(container.children);
		handle.update(buildStatusSegments(base({ stage: needsKey, console: [
			{ kind: "mode", text: "NOTE", title: "Output mode: note. Click to change." },
			{ kind: "model", text: "gpt-5.5-mini", title: "OpenAI: gpt-5.5-mini" }
		] })));
		expect(Array.from(container.children)).toEqual(before);
		expect(container.querySelector(".is-model")).toBe(modelButton);
		expect(modelButton?.textContent).toBe("gpt-5.5-mini");
		expect(modeButton?.textContent).toBe("NOTE");
		expect(container.ownerDocument.activeElement).toBe(modelButton);
		expect(container.querySelector<HTMLElement>(".is-setup")?.hidden).toBe(false);
		container.querySelector<HTMLButtonElement>(".is-setup")?.click();
		modelButton?.click();
		modeButton?.click();
		expect(log).toEqual(["setup", "model", "mode"]);
	});

	test("status chips carry the shared tone classes", () => {
		const container = createFakeEl();
		const handle = createStatusSegments(container, { onMode: () => undefined, onModel: () => undefined, onSetup: () => undefined });
		handle.update(buildStatusSegments(base({ stage: needsKey, mcp: [server("a", { kind: "needs-trust" })] })));
		const setup = container.querySelector(".is-setup");
		expect(setup?.classList.contains("askmate-status-chip")).toBe(true);
		expect(setup?.classList.contains("is-warning")).toBe(true);
		const mcp = container.querySelector(".is-mcp");
		expect(mcp?.textContent).toBe("tools: review");
		handle.update(buildStatusSegments(base()));
		expect(container.querySelector(".is-setup")?.classList.contains("is-warning")).toBe(false);
		expect(container.querySelector<HTMLElement>(".is-mcp")?.hidden).toBe(true);
	});
});
