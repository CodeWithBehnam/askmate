import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import AskMatePlugin from "../src/plugin/AskMatePlugin";
import { DIAGRAM_BRIEF_TOKEN_ALLOWANCE, TOOLS_SECTION_TOKEN_ALLOWANCE, describeAddedAtSend } from "../src/plugin/promptInspection";
import { AskMatePromptInspectorModal } from "../src/ui/modals/modals";
import { createFakeApp, type FakeApp } from "./support/fake-app";
import { installDomGlobals } from "./support/fake-dom";

let restoreDom: () => void;

beforeAll(() => {
	restoreDom = installDomGlobals();
});

afterAll(() => {
	restoreDom();
});

async function loadPlugin(stored: unknown = {}): Promise<{ plugin: AskMatePlugin; fake: FakeApp }> {
	const fake = createFakeApp();
	const plugin = new AskMatePlugin(fake.app as never, { id: "askmate", name: "AskMate", version: "1.12.0", dir: ".obsidian/plugins/askmate" } as never) as AskMatePlugin & { storedData: unknown };
	plugin.storedData = stored;
	plugin.obsidianApi = { loadMermaid: () => Promise.resolve(null), parseYaml: (text) => Bun.YAML.parse(text) };
	await plugin.onload();
	return { plugin, fake };
}

const WEB_SERVER = { id: "web", label: "Web tools", enabled: true, approval: "always-ask", trustsAnnotations: false, transport: "http", url: "https://tools.example.com/mcp", headers: {}, bearerSecretId: null, trustedConfigHash: null };

describe("the prompt inspector", () => {
	test("a diagram request says the brief is added when it is sent and counts room for it", async () => {
		const { plugin } = await loadPlugin();

		const diagram = await plugin.inspectFinalPrompt("Draw a flowchart of the release process", "AskMate Answer", { allowNoNote: true });
		const plain = await plugin.inspectFinalPrompt("Summarise the note", "AskMate Answer", { allowNoNote: true });

		expect(diagram.request.metadata.intentKind).toBe("diagram");
		expect(diagram.input).not.toContain("<diagram_brief>");
		expect(diagram.addedAtSend).toHaveLength(1);
		expect(diagram.addedAtSend[0]).toContain("diagram brief");
		expect(diagram.estimatedInputTokens).toBeGreaterThanOrEqual(DIAGRAM_BRIEF_TOKEN_ALLOWANCE);
		expect(plain.addedAtSend).toEqual([]);
	});

	test("with a ready MCP server the tools section is named too, and without one it is not", async () => {
		const { plugin } = await loadPlugin({ mcp: { enabled: true, servers: [WEB_SERVER] } });
		const without = await plugin.inspectFinalPrompt("Summarise the note", "AskMate Answer", { allowNoNote: true });
		expect(without.addedAtSend).toEqual([]);

		Object.assign(plugin.mcpService ?? {}, { status: () => [{ state: { kind: "ready" } }] });
		const withTools = await plugin.inspectFinalPrompt("Summarise the note", "AskMate Answer", { allowNoNote: true });

		expect(withTools.addedAtSend).toHaveLength(1);
		expect(withTools.addedAtSend[0]).toContain("tools section");
		expect(withTools.estimatedInputTokens).toBe(without.estimatedInputTokens + TOOLS_SECTION_TOKEN_ALLOWANCE);
		// A diagram run never uses tools, so it names only its brief.
		const diagram = await plugin.inspectFinalPrompt("Draw a flowchart of the release process", "AskMate Answer", { allowNoNote: true });
		expect(diagram.addedAtSend).toHaveLength(1);
		expect(diagram.addedAtSend[0]).toContain("diagram brief");
	});

	test("the dialog shows what is added at send time above the texts", async () => {
		const { plugin, fake } = await loadPlugin();
		const inspection = await plugin.inspectFinalPrompt("Draw a flowchart of the release process", "AskMate Answer", { allowNoNote: true });

		const modal = new AskMatePromptInspectorModal(fake.app as never, inspection);
		modal.open();
		const text = modal.contentEl.textContent ?? "";
		modal.close();

		expect(text).toContain("The diagram brief");
		expect(text.indexOf("The diagram brief")).toBeLessThan(text.indexOf("Instructions"));
	});
});

describe("describeAddedAtSend", () => {
	test("names each part the run adds and adds up their allowances", () => {
		expect(describeAddedAtSend({ isDiagram: false, toolsAvailable: false })).toEqual({ notes: [], extraTokens: 0 });
		expect(describeAddedAtSend({ isDiagram: true, toolsAvailable: false }).extraTokens).toBe(DIAGRAM_BRIEF_TOKEN_ALLOWANCE);
		expect(describeAddedAtSend({ isDiagram: false, toolsAvailable: true }).extraTokens).toBe(TOOLS_SECTION_TOKEN_ALLOWANCE);
		const both = describeAddedAtSend({ isDiagram: true, toolsAvailable: true });
		expect(both.notes).toHaveLength(2);
		expect(both.extraTokens).toBe(DIAGRAM_BRIEF_TOKEN_ALLOWANCE + TOOLS_SECTION_TOKEN_ALLOWANCE);
	});
});
