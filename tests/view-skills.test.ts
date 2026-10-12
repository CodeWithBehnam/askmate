import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hashSkillText, SkillService, type SkillConfig, type SkillFileInfo, type SkillHost } from "../src/skills";
import {
	buildSkillChips,
	renderSkillChips,
	skillChipsSignature,
	type SkillChipModel,
	type SkillLite
} from "../src/ui/sidebar/components/SkillChips";
import {
	buildSkillSelection,
	describeSkillBadge,
	describeSkillChannel,
	formatSkillsListing,
	lookUpSkill,
	skillStatusLabel,
	wasSkillAutomatic
} from "../src/ui/sidebar/components/skillSelection";
import { createFakeEl, installDomGlobals } from "./support/fake-dom";

const FOLDER = "AskMate/Skills";
const skillText = (name: string, extra = ""): string => `---\nname: ${name}\ndescription: Handles ${name} questions.\n${extra}---\n# Goal\nDo the ${name} thing.\n`;

class Host implements SkillHost {
	files = new Map<string, string>();
	trusted: Record<string, string> = {};
	config: Omit<SkillConfig, "trusted"> = { enabled: true, folder: FOLDER, matchMode: "builtin-auto", disabledIds: [] };

	parseYaml(text: string): unknown {
		return Bun.YAML.parse(text);
	}
	sha256(text: string): Promise<string> {
		return hashSkillText(text);
	}
	getConfig(): SkillConfig {
		return { ...this.config, trusted: { ...this.trusted } };
	}
	listFiles(): Promise<readonly SkillFileInfo[]> {
		return Promise.resolve(Array.from(this.files, ([path, text]) => ({ path, size: new TextEncoder().encode(text).length })));
	}
	readFile(path: string): Promise<string> {
		return Promise.resolve(this.files.get(path) ?? "");
	}
	saveTrust(id: string, hash: string | null): Promise<void> {
		if (hash === null) {
			delete this.trusted[id];
		} else {
			this.trusted[id] = hash;
		}
		return Promise.resolve();
	}
	watch(): () => void {
		return () => undefined;
	}
	setTimer(): unknown {
		return 0;
	}
	clearTimer(): void {
		return;
	}
}

async function serviceWith(files: Record<string, string>, trust: string[] = []): Promise<{ service: SkillService; host: Host }> {
	const host = new Host();
	for (const [path, text] of Object.entries(files)) {
		host.files.set(`${FOLDER}/${path}`, text);
	}
	const service = new SkillService(host);
	await service.scan();
	for (const name of trust) {
		const skill = service.get(`vault:${name}`);
		if (skill) {
			await service.trust(skill.id, skill.hash);
		}
	}
	return { service, host };
}

describe("lookUpSkill", () => {
	test("finds a built-in skill by name or by id", async () => {
		const { service } = await serviceWith({});
		expect(lookUpSkill(service, "mermaid-diagrams").ok).toBe(true);
		expect(lookUpSkill(service, "built-in:mermaid-diagrams").ok).toBe(true);
	});

	test("an unknown name says how to list the skills", async () => {
		const { service } = await serviceWith({});
		const result = lookUpSkill(service, "nope");
		expect(result).toMatchObject({ ok: false, settings: false });
		expect(result.ok === false && result.message).toContain("/skills");
	});

	test("a vault skill that has not been reviewed cannot be used and points to settings", async () => {
		const { service } = await serviceWith({ "notes.md": skillText("notes") });
		const result = lookUpSkill(service, "notes");
		expect(result).toMatchObject({ ok: false, settings: true });
		expect(result.ok === false && result.message).toContain("needs your review");
	});

	test("a reviewed skill works, and a turned-off one does not", async () => {
		const { service, host } = await serviceWith({ "notes.md": skillText("notes") }, ["notes"]);
		expect(lookUpSkill(service, "notes").ok).toBe(true);
		host.config = { ...host.config, disabledIds: ["vault:notes"] };
		const result = lookUpSkill(service, "notes");
		expect(result.ok === false && result.message).toContain("turned off");
	});

	test("a skill that can only be started by AskMate is refused with the reason", async () => {
		const { service } = await serviceWith({ "quiet.md": skillText("quiet", "user-invocable: false\n") }, ["quiet"]);
		const result = lookUpSkill(service, "quiet");
		expect(result.ok === false && result.message).toContain("only be chosen by AskMate");
	});
});

describe("buildSkillSelection", () => {
	test("lists each skill once and keeps explicit ahead of sticky", () => {
		expect(buildSkillSelection({ explicit: ["a", " a ", "b"], sticky: ["b", "c", "c"], autoEnabled: true })).toEqual({
			explicitIds: ["a", "b"],
			stickyIds: ["c"],
			autoEnabled: true
		});
	});

	test("run again without skill turns automatic choice off and keeps what the person chose", () => {
		expect(buildSkillSelection({ explicit: [], sticky: ["x"], autoEnabled: false })).toEqual({ explicitIds: [], stickyIds: ["x"], autoEnabled: false });
	});
});

describe("wording", () => {
	test("says how a skill came to be used", () => {
		expect(describeSkillChannel("auto")).toContain("AskMate picked");
		expect(describeSkillChannel("explicit")).toBe("you chose it");
		const badge = describeSkillBadge({ id: "built-in:mermaid-diagrams", name: "mermaid-diagrams", source: "built-in", channel: "auto" });
		expect(badge.text).toBe("Skill: mermaid-diagrams");
		expect(badge.title).toContain("built in");
	});

	test("offers Run again without skill only when a skill started on its own", () => {
		expect(wasSkillAutomatic([{ id: "a", name: "a", source: "vault", channel: "auto" }])).toBe(true);
		expect(wasSkillAutomatic([{ id: "a", name: "a", source: "vault", channel: "explicit" }])).toBe(false);
		expect(wasSkillAutomatic(undefined)).toBe(false);
	});

	test("lists skills with their status and marks the ones kept on", async () => {
		const { service } = await serviceWith({ "notes.md": skillText("notes") });
		const text = formatSkillsListing(service.list(), (skill) => service.statusOf(skill), ["built-in:mermaid-diagrams"]);
		expect(text).toContain("* mermaid-diagrams");
		expect(text).toContain("needs review");
		expect(text).toContain("/skill <name>");
		expect(skillStatusLabel("disabled")).toBe("turned off");
	});

	test("an empty catalogue points to settings", () => {
		expect(formatSkillsListing([], () => "ready", [])).toContain("Open settings");
	});
});

function lite(id: string, name: string, characters = 1234, title = ""): SkillLite {
	return { id, name, characters, manifest: { title } } as SkillLite;
}

describe("skill chips", () => {
	test("sticky and one-off skills are active, a suggestion is its own chip", () => {
		const chips = buildSkillChips({
			sticky: [lite("built-in:a", "a", 3200, "Alpha")],
			once: [lite("vault:b", "b")],
			suggestion: { id: "vault:c", name: "c", reason: "Looks like a meeting question." }
		});
		expect(chips.map((chip) => [chip.state, chip.label])).toEqual([["sticky", "Alpha"], ["once", "b"], ["suggested", "c?"]]);
		expect(chips[0]?.title).toContain("3,200 characters");
		expect(chips[2]?.title).toContain("Looks like a meeting question.");
	});

	test("a skill is never listed twice, and a suggestion for a skill already on is dropped", () => {
		const skill = lite("built-in:a", "a");
		const chips = buildSkillChips({ sticky: [skill], once: [skill], suggestion: { id: "built-in:a", name: "a", reason: "" } });
		expect(chips).toHaveLength(1);
		expect(chips[0]?.state).toBe("sticky");
	});

	test("the signature changes only when what is shown changes", () => {
		const first = buildSkillChips({ sticky: [lite("a", "a")], once: [], suggestion: null });
		const same = buildSkillChips({ sticky: [lite("a", "a", 99)], once: [], suggestion: null });
		const other = buildSkillChips({ sticky: [lite("a", "a")], once: [lite("b", "b")], suggestion: null });
		expect(skillChipsSignature(first)).toBe(skillChipsSignature(same));
		expect(skillChipsSignature(first)).not.toBe(skillChipsSignature(other));
	});

	describe("DOM", () => {
		let restore: () => void;
		beforeAll(() => {
			restore = installDomGlobals();
		});
		afterAll(() => restore());

		test("draws pressed buttons for active skills and routes clicks", () => {
			const container = createFakeEl();
			const removed: SkillChipModel[] = [];
			const accepted: SkillChipModel[] = [];
			const chips = buildSkillChips({ sticky: [lite("a", "a")], once: [], suggestion: { id: "b", name: "b", reason: "" } });
			renderSkillChips(container, chips, { onRemove: (chip) => removed.push(chip), onAccept: (chip) => accepted.push(chip) });
			const buttons = container.querySelectorAll<HTMLButtonElement>(".askmate-skill-chip");
			expect(buttons).toHaveLength(2);
			expect(buttons[0]?.classList.contains("is-active")).toBe(true);
			expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
			expect(buttons[1]?.classList.contains("is-suggested")).toBe(true);
			expect(buttons[1]?.hasAttribute("aria-pressed")).toBe(false);
			buttons[0]?.click();
			buttons[1]?.click();
			expect(removed.map((chip) => chip.id)).toEqual(["a"]);
			expect(accepted.map((chip) => chip.id)).toEqual(["b"]);
			expect(container.hidden).toBe(false);
		});

		test("the row hides itself when there is nothing to show", () => {
			const container = createFakeEl();
			renderSkillChips(container, [], { onRemove: () => undefined, onAccept: () => undefined });
			expect(container.hidden).toBe(true);
			expect(container.children).toHaveLength(0);
		});
	});
});
