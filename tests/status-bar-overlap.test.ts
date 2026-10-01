import { describe, expect, test } from "bun:test";
import { getStatusBarOverlap } from "../src/ui/sidebar/statusBarOverlap";

// A 1440 x 900 window with AskMate in the right sidebar, as in the reported screenshot.
const rightSidebar = { top: 40, right: 1440, bottom: 900, left: 1040 };
const statusBar = { top: 874, right: 1440, bottom: 900, left: 1150 };

describe("getStatusBarOverlap", () => {
	test("reserves the status bar's height when it covers the bottom of the sidebar", () => {
		expect(getStatusBarOverlap(rightSidebar, statusBar)).toBe(26);
	});

	test("rounds fractional overlaps up so no pixel of the composer stays covered", () => {
		expect(getStatusBarOverlap(rightSidebar, { ...statusBar, top: 873.4 })).toBe(27);
	});

	test("reserves nothing when the view sits elsewhere", () => {
		const leftSidebar = { top: 40, right: 300, bottom: 900, left: 0 };
		expect(getStatusBarOverlap(leftSidebar, statusBar)).toBe(0);
	});

	test("reserves nothing when the view ends above the status bar", () => {
		expect(getStatusBarOverlap({ ...rightSidebar, bottom: 600 }, statusBar)).toBe(0);
	});

	test("reserves nothing when the status bar is missing or hidden", () => {
		expect(getStatusBarOverlap(rightSidebar, null)).toBe(0);
		expect(getStatusBarOverlap(rightSidebar, { top: 0, right: 0, bottom: 0, left: 0 })).toBe(0);
	});

	test("never reserves more than the view's own height", () => {
		const shortView = { top: 880, right: 1440, bottom: 900, left: 1040 };
		expect(getStatusBarOverlap(shortView, statusBar)).toBe(20);
	});
});
