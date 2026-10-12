import type { Skill, SkillStatus } from "./types";

/**
 * The text a trust record is taken from: the file as read, minus a byte order mark, with line endings normalised so a
 * Windows checkout of the same file keeps its approval. Every other byte counts, including whitespace, comments and
 * invisible characters, so any real edit sends the skill back to review.
 */
export function normaliseForHash(raw: string): string {
	return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export type Sha256 = (text: string) => Promise<string>;

/** Hashes with the Web Crypto API, which Obsidian's desktop and mobile runtimes and Bun all provide. */
export const sha256Hex: Sha256 = async (text) => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export async function hashSkillText(raw: string, sha256: Sha256 = sha256Hex): Promise<string> {
	return sha256(normaliseForHash(raw));
}

export function isValidHash(value: string): boolean {
	return /^[0-9a-f]{64}$/.test(value);
}

export type TrustRecord = Readonly<Record<string, string>>;

/** Built-in skills are always trusted. A vault skill is trusted only while its text hashes to the approved value. */
export function isSkillTrusted(skill: Skill, trusted: TrustRecord): boolean {
	if (!skill.valid) {
		return false;
	}
	if (skill.source === "built-in") {
		return true;
	}
	const approved = trusted[skill.id];
	return typeof approved === "string" && approved === skill.hash;
}

export function skillStatus(skill: Skill, trusted: TrustRecord, disabledIds: readonly string[] = []): SkillStatus {
	if (!skill.valid) {
		return "invalid";
	}
	if (disabledIds.includes(skill.id)) {
		return "disabled";
	}
	if (skill.source === "built-in") {
		return "built-in";
	}
	return isSkillTrusted(skill, trusted) ? "ready" : "needs-review";
}
