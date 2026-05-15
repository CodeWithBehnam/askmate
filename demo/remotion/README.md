# AskMate Remotion Demo

This folder contains a self-contained Remotion video project for the AskMate Obsidian plugin.

The composition is a polished, deterministic product walkthrough. It recreates an Obsidian-style workspace instead of relying on a screen recording, which makes the video easier to revise as AskMate changes.

## Demo

- Composition: `AskMateProductDemo`
- Duration: 75 seconds
- Size: 1920x1080
- FPS: 30
- Thumbnail still: `AskMateThumbnail`

## Scenes

1. Intro: AskMate as an Obsidian plugin.
2. Ask: type a note-aware question into the sidebar.
3. Workflows: show reusable workflow shortcuts.
4. Safe Apply: preview a Markdown diff before writing to the vault.
5. Providers and privacy: show provider options and privacy defaults.
6. Outro: final workspace and GitHub call to action.

## Setup

Install dependencies from this folder:

```bash
bun install
```

Or use the root convenience script:

```bash
bun run demo:video
```

The repository directory contains an exclamation mark, which Remotion's Webpack bundler rejects when rendering directly from this path. The root `demo:*` scripts mirror this folder into `/private/tmp/askmate-remotion-demo-work` before launching Remotion.

## Render

From this folder:

```bash
bun run render
```

From the repo root:

```bash
bun run demo:render
```

The rendered video is written to:

```text
demo/remotion/out/askmate-product-demo.mp4
```

When using the root script, rendering happens from a temporary path and the `out` folder is copied back here:

```text
demo/remotion/out/askmate-product-demo.mp4
```

You can also render the thumbnail:

```bash
bun run demo:still
```

## Edit

Most copy is in:

```text
demo/remotion/src/data/script.ts
```

Colors are in:

```text
demo/remotion/src/data/theme.ts
```
