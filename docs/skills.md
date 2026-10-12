# Skills

A skill is a short, reusable set of instructions that AskMate adds to a request when it fits. AskMate uses the Agent Skills `SKILL.md` format, so a skill you write here can work in other tools that read it too.

Skills are instructions only. A skill cannot call tools, fetch pages, write files, change settings or switch on another skill.

## Built in

`mermaid-diagrams` ships with AskMate. It holds the type guidance and syntax rules for [Mermaid diagrams](diagrams.md). It is always trusted, and a vault skill can never take its name.

## Your own skills

Put skills in a visible vault folder, `AskMate/Skills` by default (change it in settings under skills and tools; a dot-folder is not accepted). Either layout works:

```text
AskMate/Skills/meeting-minutes/SKILL.md
AskMate/Skills/meeting-minutes.md
```

A skill file is Markdown with a short header:

```markdown
---
name: meeting-minutes
description: Turns a meeting note into minutes with decisions, action items and owners. Use when the user asks for minutes, action items or a recap of a meeting.
triggers:
  - meeting minutes
  - action items
---
# Goal
Produce minutes that someone who missed the meeting can act on.

# Output
Sections in order: Summary, Decisions, Action items, Open questions.
```

`name` and `description` are required. The name uses lower-case letters, digits and single hyphens, up to 64 characters. The description says what the skill does and when to use it, up to 1,024 characters. Optional fields: `title`, `when_to_use`, `triggers`, `disable-model-invocation` (never suggest or apply it on its own), `user-invocable`, `argument-hint`, `output-kind`, `icon`, `accent` and `requires-mcp` (the MCP servers it expects). Fields AskMate does not know are ignored, and so are `scripts`, `references`, `assets` and `allowed-tools`, which the review screen lists as ignored.

Limits: a vault skill body is at most 10,000 characters, a file at most 64 KB, a scan reads up to 200 files two folders deep, and the folder is rescanned shortly after you change a file.

`Install examples` in settings adds starter skills you can edit: meeting minutes, Anki flashcards, weekly review, Cornell notes and translate keeping format. <!-- TODO(lead): confirm the settings label for installing examples and creating a skill from a template (WP-12). -->

## Trust

A vault skill does nothing until you review it. The review screen shows the raw text, how many invisible characters and hidden comments were removed, advisory warnings, and, after a change, a diff. Approving it records the SHA-256 of the cleaned text. Any byte change returns the skill to Needs review. A skill you create with AskMate's own editor is trusted when you save it.

Skill text goes into the instructions part of the request, so read it as you would read any prompt before you approve it.

## How a skill is chosen

| Way | How |
| --- | --- |
| By name | `/skill <name> [question]`, or `@skill:name` in the question. |
| By chip | AskMate suggests at most one skill as a chip under the composer. Press it to use it. |
| By workflow | A workflow can name up to three skills that always apply. |
| For a chat | `/skill <name>` with no question keeps the skill for the rest of the conversation. |
| Automatically | A local matcher scores the request against each skill's name, triggers and description. No extra model call is made. |

The skill matching setting has four choices: off, suggest only (chips, never automatic), built-in skills automatic (the default) and all trusted skills automatic. <!-- TODO(lead): the stored values are off, suggest, builtin-auto and all-auto. Use the labels from the merged settings tab. -->

Limits per request: three skills, one of them automatic, and 16,000 characters of skill text in total. Skills are sorted by id so the same request reads the same way each time.

## What a skill cannot do

Your question and your custom instructions outrank a skill. A skill cannot override AskMate's rules for evidence, output and stopping, or the rule that note text is data and not instructions. A skill that does not fit the request is ignored. The sidebar names the skill used on a reply, and `/inspect` shows the final prompt.
