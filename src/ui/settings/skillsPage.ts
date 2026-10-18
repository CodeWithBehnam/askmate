import { Notice, normalizePath, type App, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import { DIAGRAM_KINDS } from "../../diagrams/types";
import { STYLE_RECIPES } from "../../diagrams/recipes";
import { DEFAULT_SKILLS_FOLDER, EXAMPLE_SKILL_TEMPLATES, createSkillScaffold, hashSkillText, type Skill, type SkillStatus, type SkillTemplate } from "../../skills";
import { askSkillReview } from "../modals/SkillReviewModal";
import { statusChipClass, type ChipTone, type SettingsPageHost } from "./connectionPage";
import { attachFolderSuggest } from "./pathSuggest";
import { SKILL_MATCHING_OPTIONS, resolveFolderPathInput, uniqueLabels, writeSettingControl } from "./settingsInputs";
import { pluralise } from "./settingsSummaries";

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

export const SKILL_STATUS_LABELS: Readonly<Record<SkillStatus, string>> = {
	"built-in": "Built-in",
	ready: "Ready",
	"needs-review": "Needs review",
	disabled: "Disabled",
	invalid: "Invalid"
};

const SKILL_STATUS_TONES: Readonly<Record<SkillStatus, ChipTone>> = {
	"built-in": "off",
	ready: "ready",
	"needs-review": "warning",
	disabled: "off",
	invalid: "error"
};

export function skillStatusChip(status: SkillStatus): { tone: ChipTone; label: string } {
	return { tone: SKILL_STATUS_TONES[status], label: SKILL_STATUS_LABELS[status] };
}

function firstSentence(text: string, maxLength: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const sentence = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
	return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 3).trimEnd()}...` : sentence;
}

/** The two lines a skill row shows. A file that could not be read says why instead of showing a description it does not have. */
export function describeSkillRow(skill: Skill, status: SkillStatus): { title: string; desc: string } {
	const title = skill.manifest.title.trim() || skill.name;
	if (status === "invalid") {
		const reason = skill.diagnostics.find((diagnostic) => diagnostic.level === "error")?.message ?? "The file could not be read as a skill.";
		return { title: skill.path ? `${title} (${skill.path})` : title, desc: reason };
	}
	const where = skill.source === "built-in" ? "Built in" : skill.path;
	return { title, desc: `${where} · ${firstSentence(skill.manifest.description, 140)}` };
}

export function toggleDisabledId(ids: readonly string[], id: string, disabled: boolean): string[] {
	const rest = ids.filter((candidate) => candidate !== id);
	return disabled ? [...rest, id] : rest;
}

export function countSkills(skills: readonly Skill[], statusOf: (skill: Skill) => SkillStatus): { total: number; needsReview: number; invalid: number } {
	const statuses = skills.map(statusOf);
	return {
		total: skills.filter((skill) => skill.valid).length,
		needsReview: statuses.filter((status) => status === "needs-review").length,
		invalid: statuses.filter((status) => status === "invalid").length
	};
}

export interface PlannedSkillFile {
	path: string;
	content: string;
	title: string;
}

/** Where each template goes under the skills folder, and which ones already exist and are left alone. */
export function planSkillFiles(folder: string, templates: readonly SkillTemplate[], existingPaths: ReadonlySet<string>): { create: PlannedSkillFile[]; skipped: string[] } {
	const root = folder.replace(/\/+$/, "") || DEFAULT_SKILLS_FOLDER;
	const planned = templates.map((template) => ({ path: normalizePath(`${root}/${template.path}`), content: template.content, title: template.title }));
	return {
		create: planned.filter((file) => !existingPaths.has(file.path)),
		skipped: planned.filter((file) => existingPaths.has(file.path)).map((file) => file.title)
	};
}

/** The folders above a file, outermost first, so each can be created in turn. */
export function ancestorFolders(path: string): string[] {
	const parts = path.split("/").slice(0, -1);
	return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export const DIAGRAM_KIND_LABELS: Readonly<Record<(typeof DIAGRAM_KINDS)[number], string>> = {
	flowchart: "Flowchart", sequence: "Sequence", class: "Class", state: "State", er: "Entity relationship", gantt: "Gantt", pie: "Pie",
	quadrant: "Quadrant", mindmap: "Mind map", timeline: "Timeline", gitGraph: "Git graph", sankey: "Sankey", xychart: "XY chart",
	block: "Block", packet: "Packet", kanban: "Kanban", architecture: "Architecture", radar: "Radar", treemap: "Treemap",
	journey: "User journey", requirement: "Requirement", c4: "C4", venn: "Venn", ishikawa: "Fishbone"
};

/** Diagram types as stored: the settings normaliser keeps a lower-case slug, so "gitGraph" is saved as "gitgraph". */
export function diagramTypeOptions(): Record<string, string> {
	return { auto: "Choose from the note", ...Object.fromEntries(DIAGRAM_KINDS.map((kind) => [kind.toLowerCase(), DIAGRAM_KIND_LABELS[kind]])) };
}

export function diagramStyleOptions(): Record<string, string> {
	return { auto: "A new look for each note", ...Object.fromEntries(STYLE_RECIPES.map((recipe) => [recipe.id, recipe.name])) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Vault writes
// ---------------------------------------------------------------------------------------------------------------------

async function ensureFolders(app: App, path: string): Promise<void> {
	for (const folder of ancestorFolders(path)) {
		if (!app.vault.getFolderByPath(folder)) {
			await app.vault.createFolder(folder);
		}
	}
}

/** Creates the files that do not exist yet and returns their paths. Existing files are never overwritten. */
async function writePlannedFiles(app: App, files: readonly PlannedSkillFile[]): Promise<string[]> {
	const created: string[] = [];
	for (const file of files) {
		await ensureFolders(app, file.path);
		await app.vault.create(file.path, file.content);
		created.push(file.path);
	}
	return created;
}

function existingSkillPaths(app: App, folder: string, templates: readonly SkillTemplate[]): Set<string> {
	const root = folder.replace(/\/+$/, "") || DEFAULT_SKILLS_FOLDER;
	return new Set(templates.map((template) => normalizePath(`${root}/${template.path}`)).filter((path) => app.vault.getAbstractFileByPath(path) !== null));
}

// ---------------------------------------------------------------------------------------------------------------------
// The skills part of the page
// ---------------------------------------------------------------------------------------------------------------------

export function buildSkillItems(host: SettingsPageHost): SettingDefinitionItem[] {
	const { app, plugin } = host;
	const settings = plugin.settings;
	const service = plugin.skillService;
	const skillsOn = (): boolean => settings.skills.enabled;
	const skills = service.list();
	const labels = uniqueLabels(skills.map((skill) => describeSkillRow(skill, service.statusOf(skill)).title));

	const rescanAndRedraw = async (): Promise<void> => {
		await service.scan();
		host.update();
	};

	const review = async (skill: Skill): Promise<void> => {
		// The text on screen and the hash that is approved come from the same object, so a file edited meanwhile stays unapproved.
		const approved = await askSkillReview(app, skill, host.approvedSkillText.get(skill.id) ?? null);
		if (!approved) {
			return;
		}
		await service.trust(skill.id, skill.hash);
		host.approvedSkillText.set(skill.id, skill.raw);
		new Notice(`Approved "${skill.manifest.title || skill.name}". It can now be used.`);
		host.focusAfterRebuild = `skill:${skill.id}`;
		host.update();
	};

	const skillRows: SettingDefinition[] = skills.map((skill, index): SettingDefinition => {
		const status = (): SkillStatus => service.statusOf(skill);
		const row = describeSkillRow(skill, status());
		return {
			name: labels[index] ?? row.title,
			desc: row.desc,
			aliases: [...skill.manifest.triggers],
			render: (setting) => {
				const chip = setting.controlEl.createSpan({ cls: "askmate-skill-row-chip" });
				setting.settingEl.addClass("askmate-skill-row");
				const paint = (): void => {
					const next = skillStatusChip(status());
					chip.className = `askmate-skill-row-chip ${statusChipClass(next.tone)}`;
					chip.setText(next.label);
				};
				paint();
				if (skill.valid && skill.source === "vault" && status() === "needs-review") {
					setting.addButton((button) => {
						host.labelControl(button.buttonEl, `Review ${row.title}`);
						button.setButtonText("Review").setCta().setClass("askmate-cta").onClick(() => {
							void host.runSettingAction(() => review(skill));
						});
						if (host.focusAfterRebuild === `skill:${skill.id}`) {
							host.focusAfterRebuild = null;
							button.buttonEl.focus();
						}
					});
				}
				if (skill.valid && skill.source === "vault" && status() === "ready") {
					setting.addButton((button) => {
						host.labelControl(button.buttonEl, `Withdraw approval for ${row.title}`);
						button.setButtonText("Withdraw approval").onClick(() => {
							void host.runSettingAction(async () => {
								await service.revoke(skill.id);
								host.focusAfterRebuild = `skill:${skill.id}`;
								host.update();
							});
						});
						if (host.focusAfterRebuild === `skill:${skill.id}`) {
							host.focusAfterRebuild = null;
							button.buttonEl.focus();
						}
					});
				}
				if (skill.source === "vault" && skill.path) {
					setting.addExtraButton((button) => {
						host.describeExtraButton(button.setIcon("file-text"), `Open ${row.title} in the editor`);
						button.onClick(() => {
							void host.runSettingAction(() => app.workspace.openLinkText(skill.path, "", "tab"));
						});
					});
				}
				if (skill.valid) {
					setting.addToggle((toggle) => {
						host.setupToggle(toggle, `Use ${row.title}`, !settings.skills.disabledIds.includes(skill.id), async (enabled) => {
							settings.skills = { ...settings.skills, disabledIds: toggleDisabledId(settings.skills.disabledIds, skill.id, !enabled) };
							await host.runSettingAction(() => host.saveUiSetting());
							paint();
						});
					});
				}
			}
		};
	});

	const skillsFolderRow: SettingDefinition = {
		name: "Skills folder",
		desc: `AskMate looks for skills in this vault folder. Use a visible folder, not one that starts with a dot.`,
		visible: skillsOn,
		render: (setting) => {
			host.prepareFieldFeedback(setting);
			setting.addText((text) => {
				host.labelControl(text.inputEl, "Skills folder");
				text.setPlaceholder(DEFAULT_SKILLS_FOLDER).setValue(settings.skills.folder);
				const commit = host.bindCommitOnBlurOrEnter(text.inputEl, async () => {
					const result = resolveFolderPathInput(text.getValue());
					if (result.kind === "unsafe") {
						host.setFieldFeedback(setting, "The folder cannot contain \".\" or \"..\" segments. AskMate kept the previous folder.");
						text.setValue(settings.skills.folder);
						return;
					}
					const before = settings.skills.folder;
					writeSettingControl(settings, "skillsFolder", result.value);
					text.setValue(settings.skills.folder);
					// A dot-folder is not indexed by Obsidian, so the normaliser puts the default back and the person is told.
					host.setFieldFeedback(setting, result.value && settings.skills.folder !== result.value
						? `Skills cannot live in a hidden folder, so AskMate uses ${settings.skills.folder}.`
						: null, "info");
					if (settings.skills.folder === before) {
						return;
					}
					await host.saveUiSetting();
					await rescanAndRedraw();
				});
				attachFolderSuggest(app, text.inputEl, commit);
			});
		}
	};

	const newSkillRow: SettingDefinition = {
		name: "New skill from template",
		desc: "Type a name, then edit the file that AskMate creates. AskMate approves the file as it creates it, so after you edit it, press Review and approve it again before it is used.",
		visible: skillsOn,
		render: (setting) => {
			host.prepareFieldFeedback(setting);
			let name = "";
			setting.addText((text) => {
				host.labelControl(text.inputEl, "Skill name");
				text.setPlaceholder("Meeting minutes").onChange((value) => {
					name = value;
				});
			});
			setting.addButton((button) => {
				button.setButtonText("Create skill").onClick(() => {
					void host.keepFocusWhileBusy(button.buttonEl, (busy) => { button.setDisabled(busy); }, () => host.runSettingAction(async () => {
						if (!name.trim()) {
							host.setFieldFeedback(setting, "Type a name for the skill first.");
							return;
						}
						const template = createSkillScaffold(name, "");
						const { create, skipped } = planSkillFiles(settings.skills.folder, [template], existingSkillPaths(app, settings.skills.folder, [template]));
						if (create.length === 0) {
							host.setFieldFeedback(setting, `A skill named "${skipped[0] ?? name}" already exists in ${settings.skills.folder}.`);
							return;
						}
						const [created] = await writePlannedFiles(app, create);
						// A skill made here is text AskMate wrote itself, so it is approved as saved. Any later edit asks for a review.
						await service.scan();
						await service.trust(`vault:${template.id}`, await hashSkillText(template.content));
						host.setFieldFeedback(setting, `Created ${created}. It needs your review again once you edit it.`, "success");
						if (created) {
							await app.workspace.openLinkText(created, "", "tab");
						}
						host.update();
					}));
				});
			});
		}
	};

	const examplesRow: SettingDefinition = {
		name: "Install examples",
		desc: "Adds five starter skills to your skills folder. Each one needs your review before it is used.",
		visible: skillsOn,
		render: (setting) => {
			host.prepareFieldFeedback(setting);
			setting.addButton((button) => {
				button.setButtonText("Install examples").onClick(() => {
					void host.keepFocusWhileBusy(button.buttonEl, (busy) => { button.setDisabled(busy); }, () => host.runSettingAction(async () => {
						const plan = planSkillFiles(settings.skills.folder, EXAMPLE_SKILL_TEMPLATES, existingSkillPaths(app, settings.skills.folder, EXAMPLE_SKILL_TEMPLATES));
						const created = await writePlannedFiles(app, plan.create);
						const kept = plan.skipped.length > 0 ? ` ${pluralise(plan.skipped.length, "example")} already existed and was left alone.` : "";
						host.setFieldFeedback(setting, created.length > 0 ? `Added ${pluralise(created.length, "example skill")}. Review each one before it is used.${kept}` : `Nothing to add.${kept}`, "success");
						await rescanAndRedraw();
					}));
				});
			});
			setting.addExtraButton((button) => {
				host.describeExtraButton(button.setIcon("refresh-cw"), "Scan the skills folder again");
				button.onClick(() => {
					void host.runSettingAction(rescanAndRedraw);
				});
			});
		}
	};

	const folderIssues = service.issues();
	const issueRows: SettingDefinition[] = folderIssues.map((issue) => host.noteDefinition(issue.message));

	const listRows: SettingDefinition[] = skillRows.length > 0
		? skillRows
		: [host.noteDefinition("No skills were found.")];

	return [
		{
			type: "group",
			heading: "Skills",
			items: [
				host.noteDefinition("A skill is a short set of instructions that AskMate adds to a request when it fits, such as how to write meeting minutes. Skills are text only: they cannot run code or change your notes."),
				host.toggleDefinition("skillsEnabled", "Use skills", "Let AskMate add skills to requests."),
				host.dropdownDefinition("skillsMatching", "When to use a skill", "How AskMate picks a skill when you do not choose one. Your own request and instructions always come first.", { ...SKILL_MATCHING_OPTIONS }, { visible: skillsOn }),
				skillsFolderRow,
				newSkillRow,
				examplesRow,
				...issueRows
			]
		},
		{ type: "group", heading: "Your skills", items: listRows.map((row) => ({ ...row, visible: row.visible ?? skillsOn })) }
	];
}

// ---------------------------------------------------------------------------------------------------------------------
// The diagrams part of the page
// ---------------------------------------------------------------------------------------------------------------------

export function buildDiagramItems(host: SettingsPageHost): SettingDefinitionItem[] {
	const settings = host.plugin.settings;
	const diagramsOn = (): boolean => settings.diagrams.enabled;
	return [
		{
			type: "group",
			heading: "Diagrams",
			items: [
				host.toggleDefinition("diagramsEnabled", "Draw diagrams from notes", "Turn requests such as \"draw a diagram of this note\" into a Mermaid diagram you can insert."),
				host.dropdownDefinition("diagramDefaultType", "Default diagram type", "The type AskMate draws unless you ask for another.", diagramTypeOptions(), { visible: diagramsOn }),
				host.dropdownDefinition("diagramDefaultStyle", "Default style", "The look of the diagram. The same note always gets the same look until you ask for another.", diagramStyleOptions(), { visible: diagramsOn }),
				host.toggleDefinition("diagramAllowRepair", "Fix diagrams that do not draw", "Allow one extra request to the model when a diagram has an error.", { visible: diagramsOn })
			]
		}
	];
}
