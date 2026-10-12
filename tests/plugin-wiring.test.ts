import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import AskMatePlugin from "../src/plugin/AskMatePlugin";
import { AskMateView } from "../src/ui/sidebar/AskMateView";

/**
 * The sidebar and the settings page call the plugin and the sidebar view directly. These guards keep it that way: a call that is
 * reached through an optional member, or through a structural stand-in for the plugin, compiles when the member is missing and then
 * does nothing, which is how a feature fails without a word.
 */

const SRC = join(import.meta.dir, "..", "src");

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return sourceFiles(path);
		}
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

const files = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));

/** Members that always exist on the plugin or on the sidebar view, so reaching one with `?.` can only hide a missing member. */
const ALWAYS_PRESENT = [
	"skillService",
	"getSetupState",
	"saveProviderApiKey",
	"testProviderConnectionDetailed",
	"openSettingsTab",
	"loadMermaidApi",
	"revokeMcpTrust",
	"startNewConversation",
	"startDiagram"
];

describe("direct calls between the UI and the plugin", () => {
	test("no source file reaches an always-present member through an optional call or access", () => {
		const optional = new RegExp(`\\b(?:${ALWAYS_PRESENT.join("|")})\\s*\\?(?:\\.|\\()`);
		const hits = files.flatMap((file) => file.text.split("\n").flatMap((line, index) => (optional.test(line) ? [`${file.path}:${index + 1}: ${line.trim()}`] : [])));
		expect(hits).toEqual([]);
	});

	test("no source file stands in for the plugin with a structural type or a cast through unknown", () => {
		const bridges = /\bPluginWave2Api\b|\bwave2\(|\bSkillServiceView\b|\bMcpServiceView\b|plugin as unknown as|as unknown as PluginWave2Api|extras\.(?:skillService|mcpService|getSetupState|saveProviderApiKey|testProviderConnectionDetailed|openSettingsTab|revokeMcpTrust)/;
		const hits = files.flatMap((file) => file.text.split("\n").flatMap((line, index) => (bridges.test(line) ? [`${file.path}:${index + 1}: ${line.trim()}`] : [])));
		expect(hits).toEqual([]);
	});

	test("nothing looks a sidebar entry point up by name at run time", () => {
		const hits = files.filter((file) => /Reflect\.(?:get|apply)\([^)]*(?:startNewConversation|startDiagram)/.test(file.text)).map((file) => file.path);
		expect(hits).toEqual([]);
	});

	test("the plugin has every member the sidebar and the settings page call", () => {
		const prototype = AskMatePlugin.prototype;
		for (const name of ["getSetupState", "saveProviderApiKey", "testProviderConnectionDetailed", "openSettingsTab", "loadMermaidApi", "revokeMcpTrust", "runOpenAIRequest", "buildRequest", "queueReviewItemFromRequest"] as const) {
			expect(typeof prototype[name]).toBe("function");
		}
		expect(Object.getOwnPropertyDescriptor(prototype, "mcpService")?.get).toBeDefined();
	});

	test("the sidebar view has the two entry points the commands call", () => {
		expect(typeof AskMateView.prototype.startNewConversation).toBe("function");
		expect(typeof AskMateView.prototype.startDiagram).toBe("function");
	});
});
