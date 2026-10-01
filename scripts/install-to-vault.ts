/*
 * Copies the built release assets into a development vault and asks Obsidian to reload AskMate.
 *
 * Environment variables:
 *   ASKMATE_VAULT_PLUGIN_DIR   Required. The plugin folder inside your vault, for example
 *                              <YourVault>/.obsidian/plugins/askmate
 *   ASKMATE_VAULT_NAME         Vault name for the reload request. Default: the vault folder name
 *                              derived from ASKMATE_VAULT_PLUGIN_DIR.
 *   ASKMATE_OBSIDIAN_CLI_PATH  Obsidian binary used for the reload request.
 *                              Default: /Applications/Obsidian.app/Contents/MacOS/obsidian (macOS).
 *   ASKMATE_INSTALL_FILES      Comma-separated files to copy. Default: main.js,manifest.json,styles.css
 *   ASKMATE_RELOAD_TIMEOUT_MS  Reload request timeout. Default: 10000
 *   ASKMATE_VERIFY_ONLY        "1" or "true" to only compare files (same as --verify-only).
 *   ASKMATE_SKIP_RELOAD        "1" or "true" to skip the reload request.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const DEFAULT_OBSIDIAN_CLI_PATH = "/Applications/Obsidian.app/Contents/MacOS/obsidian";
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

function readVaultPluginDir(): string {
	const value = process.env.ASKMATE_VAULT_PLUGIN_DIR?.trim();

	if (!value) {
		console.error(
			"ASKMATE_VAULT_PLUGIN_DIR is not set. Set it to your development vault's plugin folder, for example " +
				"ASKMATE_VAULT_PLUGIN_DIR=\"<YourVault>/.obsidian/plugins/askmate\" bun run install:vault"
		);
		process.exit(1);
	}

	return value;
}

const vaultPluginDir = readVaultPluginDir();
const obsidianCliPath = process.env.ASKMATE_OBSIDIAN_CLI_PATH || DEFAULT_OBSIDIAN_CLI_PATH;
// <vault>/.obsidian/plugins/askmate sits three levels below the vault folder, whose name Obsidian uses as the vault name.
const vaultName = process.env.ASKMATE_VAULT_NAME || basename(resolve(vaultPluginDir, "..", "..", ".."));
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
