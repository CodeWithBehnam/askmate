import { describe, expect, test } from "bun:test";
import { BLOCKED_LINK_MESSAGE, decideLinkClick, type LinkClickInput } from "../src/ui/sidebar/components/linkClicks";

const notes = new Set(["Plan", "Projects/Roadmap"]);

function click(rawHref: string | null, patch: Partial<LinkClickInput> = {}) {
	return decideLinkClick({
		rawHref,
		sourcePath: "Notes/A.md",
		newLeaf: false,
		internalClass: true,
		resolve: (linkpath) => (notes.has(linkpath) ? { path: `${linkpath}.md` } : null),
		...patch
	});
}

describe("clicks on links in a reply", () => {
	test("a link to a note that exists opens it", () => {
		const decision = click("Plan");
		expect(decision).toEqual({
			kind: "internal",
			decision: { kind: "open", linktext: "Plan", sourcePath: "Notes/A.md", newLeaf: false, resolvedPath: "Plan.md" }
		});
	});

	test("a heading, block or alias is stripped before the note is looked up", () => {
		for (const href of ["Plan#Risks", "Plan^block", "Plan|the plan", "Projects/Roadmap#Q4"]) {
			const decision = click(href);
			expect(decision.kind === "internal" && decision.decision.kind).toBe("open");
		}
	});

	test("a link to a note that does not exist is never opened, so no note is created by a click", () => {
		const decision = click("Made up by the model");
		expect(decision.kind).toBe("internal");
		expect(decision.kind === "internal" && decision.decision).toMatchObject({ kind: "notice" });
		expect(decision.kind === "internal" && decision.decision.kind === "notice" && decision.decision.message).toContain("Made up by the model");
		expect(decision.kind === "internal" && decision.decision.kind === "notice" && decision.decision.message).toContain("does not create notes");
	});

	test("a modifier click opens in a new tab", () => {
		const decision = click("Plan", { newLeaf: true });
		expect(decision.kind === "internal" && decision.decision.kind === "open" && decision.decision.newLeaf).toBe(true);
	});

	test("an empty or missing target is ignored", () => {
		expect(click(null)).toEqual({ kind: "ignore" });
		expect(click("   ")).toEqual({ kind: "ignore" });
	});
});

describe("links that are not notes", () => {
	const blocked = [
		"obsidian://new?vault=V&name=x&content=y",
		"obsidian://open?vault=V&file=Secret",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"vscode://file/etc",
		"mailto:a@example.com",
		"tel:+441234567890",
		"//evil.example/path",
		"\\\\server\\share",
		"JaVaScRiPt:alert(1)",
		"java\tscript:alert(1)",
		"&#106;avascript:alert(1)"
	];

	for (const href of blocked) {
		test(`blocks ${JSON.stringify(href)}`, () => {
			expect(click(href, { internalClass: false })).toEqual({ kind: "block", message: BLOCKED_LINK_MESSAGE });
		});
	}

	test("leaves web links to Obsidian", () => {
		expect(click("https://example.com/page", { internalClass: false })).toEqual({ kind: "ignore" });
		expect(click("http://example.com", { internalClass: false })).toEqual({ kind: "ignore" });
	});

	test("a plain relative link is treated as a vault link, and still never creates a note", () => {
		const decision = click("Plan", { internalClass: false });
		expect(decision.kind === "internal" && decision.decision.kind).toBe("open");
		const missing = click("Ghost", { internalClass: false });
		expect(missing.kind === "internal" && missing.decision.kind).toBe("notice");
	});

	test("a note link that carries a scheme is refused with a notice, not opened", () => {
		const decision = click("obsidian://new?name=x");
		expect(decision.kind === "internal" && decision.decision).toEqual({ kind: "notice", message: "AskMate does not open this kind of link from an answer." });
	});

	test("an anchor inside the note keeps working when the reply is tied to a note", () => {
		const decision = click("#Risks");
		expect(decision.kind === "internal" && decision.decision).toMatchObject({ kind: "open", resolvedPath: "Notes/A.md" });
		const noSource = click("#Risks", { sourcePath: "" });
		expect(noSource.kind === "internal" && noSource.decision.kind).toBe("notice");
	});
});
