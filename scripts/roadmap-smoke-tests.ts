#!/usr/bin/env bun

import { readFileSync } from "node:fs";

function assertIncludes(fileName: string, contents: string, expected: string, label: string): void {
	if (!contents.includes(expected)) {
		throw new Error(`${label} missing in ${fileName}: ${expected}`);
	}
}

function assertPattern(fileName: string, contents: string, pattern: RegExp, label: string): void {
	if (!pattern.test(contents)) {
		throw new Error(`${label} missing in ${fileName}: ${pattern}`);
	}
}

function assertNotPattern(fileName: string, contents: string, pattern: RegExp, label: string): void {
	if (pattern.test(contents)) {
		throw new Error(`${label} present in ${fileName}: ${pattern}`);
	}
}

const main = readFileSync("main.ts", "utf8");
const styles = readFileSync("styles.css", "utf8");
const readme = readFileSync("README.md", "utf8");

assertIncludes("main.ts", main, "ProviderRoleSettings", "provider role settings type");
assertIncludes("main.ts", main, "getChatProviderModelRef", "chat provider routing");
assertIncludes("main.ts", main, "getImagePlanningProviderRef", "image prompt planning routing");
assertIncludes("main.ts", main, "exportCustomWorkflowPresets", "workflow preset export");
assertIncludes("main.ts", main, "importCustomWorkflowPresets", "workflow preset import");
assertIncludes("main.ts", main, "expandWorkflowPrompt", "workflow variable expansion");
assertIncludes("main.ts", main, "confirmTruncatedContextFullApply", "Apply truncated-context safety guard");
assertIncludes("main.ts", main, "confirmTextApplyPreview", "Apply preview safety guard");
assertIncludes("main.ts", main, "recordOperationUsage", "usage tracking");
assertIncludes("main.ts", main, "buildPromptContextContent", "context capture and budget prompt helper");
assertIncludes("main.ts", main, "ContextAttachment", "context attachment model");
assertIncludes("main.ts", main, "threadedChatEnabled", "threaded chat setting");
assertIncludes("main.ts", main, "buildThreadHistoryAttachment", "thread history context builder");
assertIncludes("main.ts", main, "additionalContextPaths", "multi-note context setting");
assertIncludes("main.ts", main, "buildAdditionalNoteAttachments", "multi-note context builder");
assertIncludes("main.ts", main, "buildFolderContextAttachments", "folder context builder");
assertIncludes("main.ts", main, "extractExcalidrawSummary", "Excalidraw summary extraction");
assertIncludes("main.ts", main, "buildImageManifestAttachments", "image manifest context builder");
assertIncludes("main.ts", main, "ApplyScope", "partial Apply scope type");
assertIncludes("main.ts", main, "applyResponseToHeadingSection", "heading section Apply helper");
assertIncludes("main.ts", main, "resultNoteTemplate", "per-workflow result template support");
assertPattern("main.ts", main, /imagePromptPlanningProviderId:\s*"same-as-chat"/, "default planning provider role");
assertPattern("main.ts", main, /{{\s*response\s*}}/, "result template response variable");
assertPattern("main.ts", main, /{{\s*imageEmbed\s*}}/, "image result template embed variable");

assertIncludes("styles.css", styles, "askmate-composer-layout-expanded", "expanded composer layout styles");
assertIncludes("styles.css", styles, "askmate-onboarding-card", "onboarding styles");
assertIncludes("styles.css", styles, "askmate-focus-ring", "theme focus polish");

assertIncludes("README.md", readme, "Roadmap", "roadmap documentation");
assertNotPattern("README.md", readme, /^- \[ \]/m, "unchecked roadmap boxes should be absent");

console.log("AskMate roadmap smoke tests passed.");
