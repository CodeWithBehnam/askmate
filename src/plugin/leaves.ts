/**
 * Obsidian keeps tabs that were restored at start-up as deferred leaves: the file and the view type are known, but the
 * view is a placeholder until the tab is first shown. Looking at `leaf.view` alone therefore misses them, so these
 * helpers read the saved view state instead and load the view when the code really needs it.
 */

export interface LeafLike {
	getViewState(): { type: string; state?: Record<string, unknown> };
}

/** The vault path a leaf shows, from its saved state. Works for a deferred leaf. */
export function leafFilePath(leaf: LeafLike): string | null {
	const file: unknown = leaf.getViewState().state?.file;
	return typeof file === "string" ? file : null;
}

export function findLeafForFile<T extends LeafLike>(leaves: readonly T[], path: string): T | undefined {
	return leaves.find((leaf) => leafFilePath(leaf) === path);
}
