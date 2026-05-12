import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const DEFAULT_VAULT_PLUGIN_DIR =
	"/Users/behnamebrahimi/Library/Mobile Documents/com~apple~CloudDocs/Obsidian/PersonalLife/PLife/.obsidian/plugins/askmate";
const DEFAULT_OBSIDIAN_CLI_PATH = "/Applications/Obsidian.app/Contents/MacOS/obsidian";
const DEFAULT_VAULT_NAME = "PLife";
const DEFAULT_FILES = ["main.js", "manifest.json", "styles.css"];
const DEFAULT_RELOAD_TIMEOUT_MS = 10000;

const execFileAsync = promisify(execFile);

function readBooleanEnv(name: string): boolean {
	return process.env[name] === "1" || process.env[name]?.toLowerCase() === "true";
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function readInstallFiles(): string[] {
	const value = process.env.ASKMATE_INSTALL_FILES;

	if (!value) {
		return DEFAULT_FILES;
	}

	const files = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

	if (files.length === 0) {
		throw new Error("ASKMATE_INSTALL_FILES did not include any files to verify or install.");
	}

	return files;
}

const vaultPluginDir = process.env.ASKMATE_VAULT_PLUGIN_DIR || DEFAULT_VAULT_PLUGIN_DIR;
const obsidianCliPath = process.env.ASKMATE_OBSIDIAN_CLI_PATH || DEFAULT_OBSIDIAN_CLI_PATH;
const vaultName = process.env.ASKMATE_VAULT_NAME || DEFAULT_VAULT_NAME;
const reloadTimeoutMs = readPositiveIntegerEnv("ASKMATE_RELOAD_TIMEOUT_MS", DEFAULT_RELOAD_TIMEOUT_MS);
const files = readInstallFiles();
const verifyOnly = readBooleanEnv("ASKMATE_VERIFY_ONLY") || process.argv.includes("--verify-only");
const skipReload = readBooleanEnv("ASKMATE_SKIP_RELOAD");

async function sha256(path: string): Promise<string> {
	const data = await readFile(path);
	return createHash("sha256").update(data).digest("hex");
}

async function assertSameFile(source: string, target: string): Promise<void> {
	const sourceData = await readFile(source);
	const targetData = await readFile(target);

	if (!sourceData.equals(targetData)) {
		throw new Error(`${basename(source)} does not match ${target}.`);
	}
}

async function verifyFile(file: string): Promise<void> {
	const source = join(process.cwd(), file);
	const target = join(vaultPluginDir, file);
	await assertSameFile(source, target);

	const sourceHash = await sha256(source);
	const targetHash = await sha256(target);

	if (sourceHash !== targetHash) {
		throw new Error(`${file} hash mismatch: ${sourceHash} !== ${targetHash}`);
	}

	console.log(`${file}: ${sourceHash}`);
}

if (!verifyOnly) {
	await mkdir(vaultPluginDir, { recursive: true });
	await writeFile(join(vaultPluginDir, ".hotreload"), "");
}

for (const file of files) {
	const source = join(process.cwd(), file);
	const target = join(vaultPluginDir, file);

	if (!verifyOnly) {
		await writeFile(target, await readFile(source));
	}

	await verifyFile(file);
}

console.log(`AskMate ${verifyOnly ? "verified" : "installed and verified"} at ${vaultPluginDir}`);

if (verifyOnly) {
	console.log("Verify-only mode completed without copying files, writing .hotreload, or requesting Obsidian reload.");
	process.exit(0);
}

if (skipReload) {
	console.log("ASKMATE_SKIP_RELOAD is set, skipping Obsidian reload request.");
	process.exit(0);
}

try {
	await execFileAsync(obsidianCliPath, ["plugin:reload", "id=askmate", `vault=${vaultName}`], {
		timeout: reloadTimeoutMs
	});
	console.log(`AskMate reload requested in Obsidian vault ${vaultName}`);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.warn(`AskMate files are installed, but automatic reload failed: ${message}`);
	console.warn("Use Obsidian's Reload app without saving command, or disable and re-enable AskMate.");
}
