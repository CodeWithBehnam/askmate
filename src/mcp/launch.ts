import { type ChildProcess, execFile, spawn } from "child_process";
import type { ChildLike } from "./stdioTransport";
import { type LaunchRequest, fallbackPathDirs, parseMarkedValue } from "./spawnPlan";

/**
 * The only file in the plugin that imports child_process, and it does so by the bare name "child_process". Desktop only: McpService
 * never calls anything here unless Platform.isDesktopApp is true. Everything that decides what to run lives in spawnPlan.ts.
 */

const MARKER = "__ASKMATE_PATH__";
/** Constant script, no user input. A GUI-launched Obsidian does not inherit the PATH from the user's shell profile. */
const PRINT_PATH = `printf '%s' '${MARKER}'"$PATH"'${MARKER}'`;
const KNOWN_SHELL = /^\/(?:bin|usr\/bin|usr\/local\/bin|opt\/homebrew\/bin)\/(?:zsh|bash)$/;
const LOGIN_SHELL_TIMEOUT_MS = 5000;

/** Runs a login shell and returns its stdout, or an empty string when it fails. Injected in tests. */
export type ShellRunner = (shell: string, args: readonly string[]) => Promise<string>;

export const runLoginShell: ShellRunner = (shell, args) =>
	new Promise<string>((resolve) => {
		execFile(shell, [...args], { timeout: LOGIN_SHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
			resolve(error ? "" : stdout);
		});
	});

/**
 * The PATH a terminal would have, plus well-known install folders, so `npx`, `uvx` and `bun` are found when Obsidian was started
 * from the Dock or the Start menu. Only a shell in a known system folder is run, with a fixed script.
 */
export async function resolveLoginPath(
	platform: NodeJS.Platform,
	processEnv: Readonly<Record<string, string | undefined>>,
	run: ShellRunner = runLoginShell
): Promise<string | null> {
	const home = processEnv.HOME ?? "";
	const fallback = fallbackPathDirs(platform, home).join(":");
	const shell = processEnv.SHELL ?? "";
	if (platform === "win32" || !KNOWN_SHELL.test(shell)) {
		return fallback || null;
	}
	const fromShell = parseMarkedValue(await run(shell, ["-ilc", PRINT_PATH]), MARKER);
	return [fromShell, fallback].filter((part): part is string => Boolean(part)).join(":") || null;
}

/** How a signal reaches the server's whole process tree on this platform. */
export type TreeSignal =
	| { readonly kind: "group"; readonly pid: number }
	| { readonly kind: "taskkill"; readonly pid: number }
	| { readonly kind: "direct" };

/**
 * `npx`, `uvx` and wrapper scripts run the real server as a child, so signalling only the process AskMate started leaves the
 * server behind. On POSIX the child leads its own process group (see spawnChild) and the group is signalled; on Windows the tree
 * is ended with taskkill. A child that never started (no pid) is signalled directly.
 */
export function planTreeSignal(platform: NodeJS.Platform, pid: number | undefined): TreeSignal {
	if (pid === undefined) {
		return { kind: "direct" };
	}
	return platform === "win32" ? { kind: "taskkill", pid } : { kind: "group", pid };
}

/** The operations signalTree needs, so the decision above and the fallbacks below can be tested without real processes. */
export interface TreeOps {
	readonly platform: NodeJS.Platform;
	/** process.kill. Throws when the group does not exist or is not ours. */
	readonly signalGroup: (pid: number, signal: NodeJS.Signals | 0) => void;
	readonly runTaskkill: (pid: number, onFailure: () => void) => void;
}

const REAL_TREE_OPS: TreeOps = {
	platform: process.platform,
	signalGroup: (pid, signal) => {
		process.kill(-pid, signal);
	},
	runTaskkill: (pid, onFailure) => {
		execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: LOGIN_SHELL_TIMEOUT_MS }, (error) => {
			// Already gone, or not allowed: the plain signal to the direct child is all that is left to try.
			if (error) {
				onFailure();
			}
		});
	}
};

/** Signals the child and everything it started. Falls back to the direct child when the group or taskkill cannot be used. */
export function signalTree(child: Pick<ChildProcess, "pid" | "kill">, signal: "SIGTERM" | "SIGKILL", ops: TreeOps = REAL_TREE_OPS): boolean {
	const plan = planTreeSignal(ops.platform, child.pid);
	switch (plan.kind) {
		case "group":
			try {
				ops.signalGroup(plan.pid, signal);
				return true;
			} catch {
				// ESRCH when the group is already empty, EPERM when it is not ours: the direct child is still ours to signal.
				return child.kill(signal);
			}
		case "taskkill":
			ops.runTaskkill(plan.pid, () => {
				child.kill(signal);
			});
			return true;
		case "direct":
			return child.kill(signal);
	}
}

/** True while any process is left in the child's process group. Only meaningful for a child that leads its own group (POSIX). */
function groupHasMembers(pid: number | undefined, ops: TreeOps): boolean {
	if (pid === undefined || ops.platform === "win32") {
		return false;
	}
	try {
		ops.signalGroup(pid, 0);
		return true;
	} catch (error) {
		// ESRCH: nobody is left. EPERM: somebody is, but this process may not signal it, which still counts as present.
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

/**
 * Starts the server process: no shell, an argument array, and only the environment McpService built. On POSIX the child leads a
 * new process group so shutdown can reach the programs a package runner or wrapper started (see signalTree).
 */
export function spawnChild(request: LaunchRequest, ops: TreeOps = REAL_TREE_OPS): ChildLike {
	const child = spawn(request.plan.file, [...request.plan.args], {
		env: { ...request.env },
		stdio: ["pipe", "pipe", "pipe"],
		shell: false,
		detached: ops.platform !== "win32",
		windowsHide: true,
		windowsVerbatimArguments: request.plan.windowsVerbatimArguments
	});
	// Decode as UTF-8 across chunk boundaries. Without this a multi-byte character split between two reads is corrupted.
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	const killDirect = child.kill.bind(child);
	child.kill = (signal) => signalTree({ pid: child.pid, kill: killDirect }, signal === "SIGKILL" ? "SIGKILL" : "SIGTERM", ops);
	return Object.assign(child, { hasSurvivors: () => groupHasMembers(child.pid, ops) });
}
