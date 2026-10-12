import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type TreeOps, planTreeSignal, resolveLoginPath, signalTree, spawnChild } from "../../src/mcp/launch";
import { planSpawn } from "../../src/mcp/spawnPlan";

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

describe("signalling the whole process tree", () => {
	function recorder(platform: NodeJS.Platform, options: { groupFails?: boolean; taskkillFails?: boolean } = {}) {
		const calls: string[] = [];
		const ops: TreeOps = {
			platform,
			signalGroup: (pid, signal) => {
				calls.push(`group ${pid} ${String(signal)}`);
				if (options.groupFails) {
					throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
				}
			},
			runTaskkill: (pid, onFailure) => {
				calls.push(`taskkill ${pid}`);
				if (options.taskkillFails) {
					onFailure();
				}
			}
		};
		const child = { pid: 4242 as number | undefined, kill: (signal?: NodeJS.Signals | number) => { calls.push(`direct ${String(signal)}`); return true; } };
		return { calls, ops, child };
	}

	test("POSIX signals the child's process group, Windows ends the tree with taskkill, and a child that never started is signalled directly", () => {
		expect(planTreeSignal("darwin", 10)).toEqual({ kind: "group", pid: 10 });
		expect(planTreeSignal("linux", 10)).toEqual({ kind: "group", pid: 10 });
		expect(planTreeSignal("win32", 10)).toEqual({ kind: "taskkill", pid: 10 });
		expect(planTreeSignal("darwin", undefined)).toEqual({ kind: "direct" });
	});

	test("the group is signalled by its negative id and nothing else is touched", () => {
		const { calls, ops, child } = recorder("linux");
		expect(signalTree(child, "SIGTERM", ops)).toBe(true);
		expect(signalTree(child, "SIGKILL", ops)).toBe(true);
		expect(calls).toEqual(["group 4242 SIGTERM", "group 4242 SIGKILL"]);
	});

	test("a group that is gone falls back to the direct child, which reports whether anything was left", () => {
		const { calls, ops, child } = recorder("darwin", { groupFails: true });
		expect(signalTree(child, "SIGKILL", ops)).toBe(true);
		expect(calls).toEqual(["group 4242 SIGKILL", "direct SIGKILL"]);
	});

	test("Windows uses taskkill for the tree and only signals the direct child when taskkill fails", () => {
		const ok = recorder("win32");
		signalTree(ok.child, "SIGTERM", ok.ops);
		expect(ok.calls).toEqual(["taskkill 4242"]);
		const failing = recorder("win32", { taskkillFails: true });
		signalTree(failing.child, "SIGKILL", failing.ops);
		expect(failing.calls).toEqual(["taskkill 4242", "direct SIGKILL"]);
	});

	test("a child without a pid is signalled directly on every platform", () => {
		for (const platform of ["darwin", "win32"] as const) {
			const { calls, ops, child } = recorder(platform);
			child.pid = undefined;
			signalTree(child, "SIGTERM", ops);
			expect(calls).toEqual(["direct SIGTERM"]);
		}
	});

	test.skipIf(process.platform === "win32")("a real child leads its own group, and SIGKILL reaches a program it left running", async () => {
		const plan = planSpawn({ command: "/bin/sh", args: ["-c", "sleep 60 & exit 0"], env: {} }, process.platform);
		const child = spawnChild({ plan, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
		await new Promise<void>((resolve) => { child.on("exit", () => resolve()); });
		const deadline = Date.now() + 2000;
		// The shell has gone but the sleep it started has not, and the group is still addressable through the child.
		expect(child.hasSurvivors?.()).toBe(true);
		child.kill("SIGKILL");
		while (child.hasSurvivors?.() === true && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(child.hasSurvivors?.()).toBe(false);
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
