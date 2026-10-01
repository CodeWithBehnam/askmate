export interface RectLike {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/**
 * Obsidian's status bar floats over the bottom-right corner of the window without reserving space, so a view docked
 * there must leave room for it. Returns the height of the band at the bottom of the view that the status bar covers,
 * or 0 when they do not intersect (status bar hidden, view in the left sidebar, or a popout window without one).
 */
export function getStatusBarOverlap(view: RectLike, statusBar: RectLike | null): number {
	if (!statusBar) {
		return 0;
	}

	const width = Math.min(view.right, statusBar.right) - Math.max(view.left, statusBar.left);
	const height = Math.min(view.bottom, statusBar.bottom) - Math.max(view.top, statusBar.top);
	if (width <= 0 || height <= 0) {
		return 0;
	}

	return Math.ceil(view.bottom - Math.max(view.top, statusBar.top));
}
