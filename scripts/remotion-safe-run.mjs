import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const allowedCommands = new Set(["dev", "render", "still", "typecheck"]);
const command = process.argv[2] ?? "dev";

if (!allowedCommands.has(command)) {
	console.error(`Unsupported Remotion command: ${command}`);
	console.error(`Use one of: ${Array.from(allowedCommands).join(", ")}`);
	process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceDir = join(repoRoot, "demo", "remotion");
const workDir = "/private/tmp/askmate-remotion-demo-work";

const copyItems = ["package.json", "bun.lock", "tsconfig.json", "remotion.config.ts", "src"];

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

for (const item of copyItems) {
	const source = join(sourceDir, item);
	if (!existsSync(source)) {
		continue;
	}

	cpSync(source, join(workDir, item), {
		recursive: true,
		errorOnExist: false,
		force: true,
	});
}

const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
	cwd: workDir,
	stdout: "inherit",
	stderr: "inherit",
});

if (!install.success) {
	process.exit(install.exitCode ?? 1);
}

const run = Bun.spawn(["bun", "run", command], {
	cwd: workDir,
	stdout: "inherit",
	stderr: "inherit",
});

const result = await run.exited;

const tempOut = join(workDir, "out");
const repoOut = join(sourceDir, "out");
if (result === 0 && existsSync(tempOut)) {
	mkdirSync(repoOut, { recursive: true });
	cpSync(tempOut, repoOut, {
		recursive: true,
		errorOnExist: false,
		force: true,
	});
}

process.exit(result);
