import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveLoginPath } from "../../src/mcp/launch";

describe("login PATH", () => {
	test("a known shell is asked once for its PATH with a fixed script, and the result is merged with well-known folders", async () => {
		const calls: Array<{ shell: string; args: readonly string[] }> = [];
		const run = (shell: string, args: readonly string[]): Promise<string> => {
			calls.push({ shell, args });
			return Promise.resolve("welcome to my zsh!\n__ASKMATE_PATH__/Users/me/.nvm/bin:/usr/bin__ASKMATE_PATH__\n");
		};
		const result = await resolveLoginPath("darwin", { SHELL: "/bin/zsh", HOME: "/Users/me" }, run);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.shell).toBe("/bin/zsh");
		expect(calls[0]?.args[0]).toBe("-ilc");
		expect(calls[0]?.args[1]).toContain("$PATH");
		expect(result?.startsWith("/Users/me/.nvm/bin:/usr/bin:")).toBe(true);
		expect(result).toContain("/opt/homebrew/bin");
		expect(result).toContain("/Users/me/.bun/bin");
	});

	test("an unknown or user-controlled shell is never run, and the well-known folders are used instead", async () => {
		const run = (): Promise<string> => Promise.reject(new Error("must not run"));
		for (const shell of ["/tmp/evil/zsh", "zsh", "/usr/bin/fish", "", "/bin/zsh; rm -rf /"]) {
			const result = await resolveLoginPath("linux", { SHELL: shell, HOME: "/home/me" }, run);
			expect(result).toContain("/home/me/.local/bin");
		}
		expect(await resolveLoginPath("linux", { HOME: "/home/me" }, run)).toContain("/usr/local/bin");
	});

	test("a shell that fails or prints nothing useful falls back to the well-known folders", async () => {
		expect(await resolveLoginPath("darwin", { SHELL: "/bin/bash", HOME: "/Users/me" }, () => Promise.resolve(""))).toBe(
			"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/me/.local/bin:/Users/me/.bun/bin:/Users/me/.cargo/bin:/Users/me/.volta/bin"
		);
		expect(await resolveLoginPath("darwin", { SHELL: "/bin/bash", HOME: "/Users/me" }, () => Promise.resolve("no markers"))).toContain("/opt/homebrew/bin");
	});

	test("Windows has no login shell and no fallback folders", async () => {
		expect(await resolveLoginPath("win32", { SHELL: "/bin/zsh" }, () => Promise.reject(new Error("must not run")))).toBeNull();
	});
});

function listSources(directory: string): string[] {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		return statSync(path).isDirectory() ? listSources(path) : path.endsWith(".ts") ? [path] : [];
	});
}

describe("Obsidian review rules for src/mcp", () => {
	const mcpFiles = listSources("src/mcp");

	test("child_process is imported only in src/mcp/launch.ts, by its bare name, anywhere in the plugin", () => {
		const importPattern = /from\s+["'](?:node:)?child_process["']|require\(\s*["'](?:node:)?child_process["']\s*\)/;
		const importers = listSources("src").filter((path) => importPattern.test(readFileSync(path, "utf8")));
		expect(listSources("src").filter((path) => readFileSync(path, "utf8").includes("node:child_process"))).toEqual([]);
		expect(importers).toEqual([join("src", "mcp", "launch.ts")]);
		const launch = readFileSync(join("src", "mcp", "launch.ts"), "utf8");
		expect(launch).toMatch(/from "child_process"/);
		expect(launch).not.toMatch(/node:child_process/);
		expect(launch).toContain("shell: false");
		expect(launch).not.toMatch(/\bshell:\s*true\b|\bexecSync\b|\bspawnSync\b|\bexec\(/);
	});

	test("no source file under src/mcp uses fetch, timers that poll, HTML injection, eval or console output", () => {
		const forbidden: Array<[RegExp, string]> = [
			[/(?<![.\w])fetch\s*\(/, "fetch"],
			[/new\s+WebSocket|XMLHttpRequest/, "other network APIs"],
			[/\bsetInterval\b/, "setInterval"],
			[/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML/, "HTML injection"],
			[/\beval\s*\(|new Function\s*\(/, "dynamic code"],
			[/\bconsole\./, "console"],
			[/(?<![.\w])(?:setTimeout|clearTimeout)\s*\(/, "bare global timers (use window.)"]
		];
		for (const path of mcpFiles) {
			const source = readFileSync(path, "utf8");
			for (const [pattern, label] of forbidden) {
				expect({ path, label, found: pattern.test(source) }).toEqual({ path, label, found: false });
			}
		}
	});

	test("source text uses no em dashes and only plain ASCII", () => {
		for (const path of mcpFiles) {
			expect({ path, ascii: /^[\x00-\x7f]*$/.test(readFileSync(path, "utf8")) }).toEqual({ path, ascii: true });
		}
	});

	test("the public barrel does not re-export the process launcher", () => {
		expect(readFileSync(join("src", "mcp", "index.ts"), "utf8")).not.toMatch(/from "\.\/launch"/);
	});

	test("nothing under src/mcp imports Obsidian, so the whole layer runs in plain tests", () => {
		for (const path of mcpFiles) {
			expect({ path, imports: /from "obsidian"/.test(readFileSync(path, "utf8")) }).toEqual({ path, imports: false });
		}
	});
});
