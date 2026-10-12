import { describe, expect, test } from "bun:test";
import { decideInternalLink, splitLinkTarget, type InternalLinkInput } from "../src/ui/sidebar/internalLink";

const notes = new Map([
	["Vendors", "Work/Vendors.md"],
	["Plan", "Plan.md"],
	["My Note", "My Note.md"],
	["100% done", "100% done.md"]
]);

function input(rawHref: string | null, patch: Partial<InternalLinkInput> = {}): InternalLinkInput {
	return {
		rawHref,
		sourcePath: "Daily/Today.md",
		newLeaf: false,
		resolve: (linkpath) => {
			const path = notes.get(linkpath);
			return path ? { path } : null;
		},
		...patch
	};
}

describe("splitLinkTarget", () => {
	test("separates the path from heading, block and alias parts", () => {
		expect(splitLinkTarget("Vendors#Pricing|prices")).toEqual({ linkpath: "Vendors", subpath: "#Pricing" });
		expect(splitLinkTarget("Team ^abc123")).toEqual({ linkpath: "Team", subpath: "^abc123" });
		expect(splitLinkTarget("Plain")).toEqual({ linkpath: "Plain", subpath: "" });
		expect(splitLinkTarget("#Heading")).toEqual({ linkpath: "", subpath: "#Heading" });
	});
});

describe("decideInternalLink", () => {
	test("opens a note that exists, keeping the heading and the modifier click", () => {
		const decision = decideInternalLink(input("Vendors#Pricing", { newLeaf: true }));
		expect(decision).toEqual({
			kind: "open",
			linktext: "Vendors#Pricing",
			sourcePath: "Daily/Today.md",
			newLeaf: true,
			resolvedPath: "Work/Vendors.md"
		});
	});

	test("resolves against the metadata cache with the note the answer was written for", () => {
		const calls: Array<[string, string]> = [];
		decideInternalLink(input("Plan", {
			resolve: (linkpath, sourcePath) => {
				calls.push([linkpath, sourcePath]);
				return { path: "Plan.md" };
			}
		}));
		expect(calls).toEqual([["Plan", "Daily/Today.md"]]);
	});

	test("a link that matches nothing gives a notice and never opens, so no empty note is created", () => {
		const decision = decideInternalLink(input("Invented note"));
		expect(decision.kind).toBe("notice");
		expect(decision.kind === "notice" ? decision.message : "").toBe(
			"There is no note called \"Invented note\" in this vault. AskMate does not create notes from links in answers."
		);
	});

	test("a same-note heading link opens the source note, or explains when there is none", () => {
		expect(decideInternalLink(input("#Risks"))).toMatchObject({ kind: "open", linktext: "#Risks", resolvedPath: "Daily/Today.md" });
		const orphan = decideInternalLink(input("#Risks", { sourcePath: "" }));
		expect(orphan.kind).toBe("notice");
	});

	test("percent-encoded Markdown links are decoded, and a literal percent sign survives", () => {
		expect(decideInternalLink(input("My%20Note.md#x", { resolve: (linkpath) => linkpath === "My Note.md" ? { path: "My Note.md" } : null }))).toMatchObject({ kind: "open", linktext: "My Note.md#x" });
		expect(decideInternalLink(input("100% done"))).toMatchObject({ kind: "open", resolvedPath: "100% done.md" });
	});

	test("web links are left to the browser", () => {
		expect(decideInternalLink(input("https://example.com/a"))).toEqual({ kind: "ignore" });
		expect(decideInternalLink(input("HTTP://example.com"))).toEqual({ kind: "ignore" });
	});

	test("other schemes are refused with a notice", () => {
		for (const href of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "obsidian://open?vault=x", "app://local/x"]) {
			expect(decideInternalLink(input(href)).kind).toBe("notice");
		}
	});

	test("a Windows drive path is not mistaken for a scheme", () => {
		expect(decideInternalLink(input("C:\\notes\\a.md")).kind).toBe("notice");
		expect(decideInternalLink(input("C:\\notes\\a.md"))).not.toEqual({ kind: "notice", message: "AskMate does not open this kind of link from an answer." });
	});

	test("empty, missing and oversized links are ignored", () => {
		expect(decideInternalLink(input(null))).toEqual({ kind: "ignore" });
		expect(decideInternalLink(input("   "))).toEqual({ kind: "ignore" });
		expect(decideInternalLink(input("a".repeat(1001)))).toEqual({ kind: "ignore" });
	});

	test("control characters never reach the notice text", () => {
		const decision = decideInternalLink(input("Bad\u0007\nname"));
		expect(decision.kind === "notice" ? decision.message : "").toContain("\"Badname\"");
	});
});
