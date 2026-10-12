import { describe, expect, test } from "bun:test";
import { buildChildEnv, fallbackPathDirs, findCommandRisks, formatCommandLine, parseMarkedValue, planSpawn } from "../../src/mcp/spawnPlan";

describe("launch planning", () => {
	test("POSIX runs the command directly, never through a shell", () => {
		expect(planSpawn({ command: "npx", args: ["-y", "pkg"], env: {} }, "darwin")).toEqual({ file: "npx", args: ["-y", "pkg"], windowsVerbatimArguments: false });
	});

	test("Windows wraps shims in cmd.exe and refuses metacharacters", () => {
		const plan = planSpawn({ command: "npx", args: ["-y", "pkg"], env: {} }, "win32");
		expect(plan).toEqual({ file: "cmd.exe", args: ["/d", "/s", "/c", '"npx -y pkg"'], windowsVerbatimArguments: true });
		expect(() => planSpawn({ command: "npx", args: ["pkg & calc"], env: {} }, "win32")).toThrow();
		expect(planSpawn({ command: "node.exe", args: ["a & b"], env: {} }, "win32").file).toBe("node.exe");
	});

	test("rejects control characters and bad environment names", () => {
		expect(() => planSpawn({ command: "x\ny", args: [], env: {} }, "linux")).toThrow();
		expect(() => planSpawn({ command: "x", args: [], env: { "BAD NAME": "1" } }, "linux")).toThrow();
	});

	test("the child environment is an allow-list plus the server's own entries", () => {
		const env = buildChildEnv({ PATH: "/usr/bin", HOME: "/h", OPENAI_API_KEY: "sk-secret", AWS_SECRET_ACCESS_KEY: "x" }, "/opt/homebrew/bin:/usr/bin", { TOKEN: "t" });
		expect(env).toEqual({ HOME: "/h", PATH: "/opt/homebrew/bin:/usr/bin", TOKEN: "t" });
		expect(parseMarkedValue("noise__M__/a:/b__M__trailing", "__M__")).toBe("/a:/b");
		expect(parseMarkedValue("nothing", "__M__")).toBeNull();
	});
});

describe("launch planning details", () => {
	test("Windows leaves uvx and bunx to cmd's PATHEXT lookup and quotes arguments with spaces", () => {
		expect(planSpawn({ command: "uvx", args: ["mcp-server-time", "--tz", "Europe/London"], env: {} }, "win32").args[3]).toBe('"uvx mcp-server-time --tz Europe/London"');
		expect(planSpawn({ command: "npx", args: ["--prefix", "C:\\Program Files\\x"], env: {} }, "win32").args[3]).toBe('"npx --prefix "C:\\Program Files\\x""');
	});

	test("Windows .cmd and .bat files go through cmd.exe, other executables run directly", () => {
		expect(planSpawn({ command: "C:\\tools\\server.cmd", args: [], env: {} }, "win32").file).toBe("cmd.exe");
		expect(planSpawn({ command: "build.BAT", args: [], env: {} }, "win32").file).toBe("cmd.exe");
		expect(planSpawn({ command: "npx.exe", args: [], env: {} }, "win32").file).toBe("npx.exe");
		expect(planSpawn({ command: "npx", args: [], env: {} }, "linux").file).toBe("npx");
	});

	test("every cmd.exe metacharacter in the command or arguments is refused", () => {
		for (const bad of ["&", "|", "<", ">", "^", "%", "!", '"', "\r", "\n"]) {
			expect(() => planSpawn({ command: "npx", args: [`a${bad}b`], env: {} }, "win32")).toThrow();
		}
		expect(() => planSpawn({ command: "pnpm&calc", args: [], env: {} }, "win32")).not.toThrow();
		expect(() => planSpawn({ command: "server&calc.cmd", args: [], env: {} }, "win32")).toThrow();
	});

	test("NUL characters and an empty command are refused everywhere", () => {
		expect(() => planSpawn({ command: "  ", args: [], env: {} }, "linux")).toThrow();
		expect(() => planSpawn({ command: "x", args: ["a\0b"], env: {} }, "linux")).toThrow();
		expect(() => planSpawn({ command: "x", args: [], env: { A: "v\0" } }, "linux")).toThrow();
	});

	test("the login PATH wins over the inherited one, and the server's own entries win over both", () => {
		expect(buildChildEnv({ PATH: "/usr/bin" }, "/login/bin", {}).PATH).toBe("/login/bin");
		expect(buildChildEnv({ PATH: "/usr/bin" }, null, {}).PATH).toBe("/usr/bin");
		expect(buildChildEnv({ PATH: "/usr/bin" }, "/login/bin", { PATH: "/custom" }).PATH).toBe("/custom");
		expect(buildChildEnv({}, null, {})).toEqual({});
	});

	test("a Windows-style environment keeps its spelling of Path and SystemRoot, and nothing else leaks", () => {
		const env = buildChildEnv({ Path: "C:\\Windows\\System32", SYSTEMROOT: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", GITHUB_TOKEN: "ghp_secret" }, null, { MODE: "x" });
		expect(env).toEqual({ Path: "C:\\Windows\\System32", SYSTEMROOT: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", MODE: "x" });
	});

	test("an exact name wins over a differently cased one", () => {
		expect(buildChildEnv({ path: "/lower", PATH: "/upper" }, null, {})).toEqual({ PATH: "/upper" });
	});

	test("fallback directories exist on POSIX and not on Windows", () => {
		expect(fallbackPathDirs("darwin", "/Users/me")).toContain("/opt/homebrew/bin");
		expect(fallbackPathDirs("linux", "/home/me")).toContain("/home/me/.bun/bin");
		expect(fallbackPathDirs("win32", "C:\\Users\\me")).toEqual([]);
	});

	test("marked values ignore rc-file noise and an unmatched marker", () => {
		expect(parseMarkedValue("welcome!\n__M__/a:/b__M__\nbye", "__M__")).toBe("/a:/b");
		expect(parseMarkedValue("__M__/a", "__M__")).toBeNull();
		expect(parseMarkedValue("__M____M__", "__M__")).toBeNull();
	});
});

describe("command risks and display", () => {
	test("flags shells, evaluators, destructive tools and loader variables", () => {
		expect(findCommandRisks({ command: "bash", args: ["-c", "curl x | sh"], envNames: [] })).toContain("runs a shell command string");
		expect(findCommandRisks({ command: "/bin/zsh", args: ["-lc", "x"], envNames: [] })).toContain("runs a shell command string");
		expect(findCommandRisks({ command: "cmd", args: ["/c", "dir"], envNames: [] })).toContain("runs a shell command string");
		expect(findCommandRisks({ command: "node", args: ["-e", "1"], envNames: [] })).toContain("runs code given directly on the command line");
		expect(findCommandRisks({ command: "npx", args: ["-y", "--call", "x"], envNames: [] })).toContain("npx -c runs an arbitrary command");
		expect(findCommandRisks({ command: "sudo", args: ["x"], envNames: [] }).join(" ")).toContain("sudo");
		expect(findCommandRisks({ command: "C:\\Tools\\curl.exe", args: [], envNames: [] }).join(" ")).toContain("curl");
		expect(findCommandRisks({ command: "node", args: ["server.js"], envNames: ["NODE_OPTIONS"] }).join(" ")).toContain("NODE_OPTIONS");
		expect(findCommandRisks({ command: "node", args: ["a.js"], envNames: ["DYLD_INSERT_LIBRARIES"] }).join(" ")).toContain("DYLD_INSERT_LIBRARIES");
	});

	test("npx -c is flagged before the package but a server's own -c option is not", () => {
		const risk = "npx -c runs an arbitrary command";
		expect(findCommandRisks({ command: "npx", args: ["-p", "cowsay", "-c", "cowsay hi"], envNames: [] })).toContain(risk);
		expect(findCommandRisks({ command: "npx", args: ["--call=echo hi"], envNames: [] })).toContain(risk);
		expect(findCommandRisks({ command: "npx", args: ["-y", "some-server", "-c", "config.json"], envNames: [] })).toEqual([]);
		expect(findCommandRisks({ command: "npx", args: ["-y", "some-server", "--call", "x"], envNames: [] })).toEqual([]);
	});

	test("ordinary servers raise no warning", () => {
		expect(findCommandRisks({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], envNames: ["API_KEY"] })).toEqual([]);
		expect(findCommandRisks({ command: "uvx", args: ["mcp-server-git"], envNames: [] })).toEqual([]);
		expect(findCommandRisks({ command: "/opt/homebrew/bin/bun", args: ["run", "server.ts"], envNames: [] })).toEqual([]);
	});

	test("the displayed command line quotes only what needs it", () => {
		expect(formatCommandLine("npx", ["-y", "pkg"])).toBe("npx -y pkg");
		expect(formatCommandLine("node", ["my server.js", ""])).toBe('node "my server.js" ""');
		expect(formatCommandLine("echo", ['say "hi"', "$HOME"])).toBe('echo "say \\"hi\\"" "\\$HOME"');
	});
});
