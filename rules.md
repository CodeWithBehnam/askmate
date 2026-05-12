# AskMate Release and Community Review Rules

These rules capture what we learned while getting AskMate through the Obsidian Community plugin checks.

## Release discipline

- Keep `manifest.json`, `package.json`, and `versions.json` synchronized for every release.
- The Git tag must exactly match `manifest.json.version`.
- Use semantic versioning. Review-only fixes should be patch releases, for example `1.5.4` to `1.5.5`.
- Publish release assets from GitHub Actions, not from a local machine.
- Release assets must include exactly the plugin install files: `main.js`, `manifest.json`, and `styles.css`.
- Keep artifact attestations enabled for release assets.
- Old failed reviews can remain in history. The latest passing review is what matters.

## Required validation before release

Run these before every commit intended for release:

```bash
bun run test
bun run build
```

After pushing a tag, verify the GitHub release workflow completed successfully and uploaded all release assets.

## Manifest rules

- Do not include the word `Obsidian` in `manifest.json.description`. The plugin directory already provides that context.
- Keep the description short and direct.
- Keep `isDesktopOnly` accurate.
- Keep `minAppVersion` stable unless a real API requirement changes.

## Source code review rules

- Await promises, catch them, or explicitly mark fire-and-forget calls with `void`.
- Prefer awaiting Obsidian workspace calls such as `workspace.revealLeaf(...)` when already inside an async method.
- Use Obsidian `requestUrl` for network requests instead of browser `fetch`.
- Do not combine background timers such as `setInterval` with network calls unless the behavior is essential, disclosed, and user-controlled.
- Use `activeDocument` instead of global `document` for popout window compatibility.
- Use `app.vault.configDir` instead of hardcoding `.obsidian`.
- Avoid native `prompt(...)` and `confirm(...)`; use Obsidian `Modal` based UI.
- Do not create HTML heading elements directly for settings UI. Use `new Setting(containerEl).setName(...).setHeading()`.
- Settings headings must not include the plugin name.
- Settings headings must not use the word `settings`. Use section names such as `Providers`, `Context`, `Workflows`, or `Usage`.
- Command IDs should not repeat the plugin ID.
- Command names should not repeat the plugin name.

## CSS review rules

- Avoid broad `:has(...)` selectors. Add explicit state classes from TypeScript instead.
- Avoid `clip-path` in plugin CSS unless there is no practical alternative.
- Avoid `column-gap`; use `gap` when possible.
- Keep selectors narrow and scoped under AskMate classes.
- Prefer simple layout primitives that Obsidian's supported Chromium versions handle reliably.
- Re-scan CSS after UI changes for partially supported browser features.

## UI implementation rules

- If CSS needs parent state, add a class in TypeScript rather than relying on broad selector invalidation.
- Keep visually hidden text accessible while avoiding CSS features flagged by the community review checker.
- Preserve current layout behavior when replacing review-flagged CSS. Review fixes should be minimal unless the design itself is wrong.

## Public documentation rules

- Do not include local vault paths, local usernames, private repository paths, or machine-specific commands in public docs.
- Keep public setup instructions generic.
- Mention local deployment scripts only as maintainer conveniences, not as required public workflow.
- Keep issue templates, PR template, security policy, contributing guide, code of conduct, and license present in the public repository.

## Community submission workflow

- First create and publish the plugin repository release.
- Then add the plugin entry to the Obsidian community plugin submission flow.
- If the old pull request route is disabled, use the current Obsidian plugin submission website instead.
- After each fix, click `Review branch` again and confirm the latest commit and version are being reviewed.
- Treat `Pending` as normal while checks are still running.
- Treat older failed rows as historical once a newer review completes successfully.
- When checks pass, wait for Obsidian maintainers to approve and publish the plugin. This can take days or weeks depending on their queue.

## Debugging review failures

- Fix the exact latest review row first. Confirm the commit hash and version before changing code.
- Do not chase old failed rows unless the same issue appears in the newest row.
- For each warning, identify whether it applies to source code, release assets, manifest metadata, CSS lint, or build verification.
- Make minimal behavior-preserving changes for review warnings.
- After each public-review fix, release a new patch version so the review can run against fresh assets.

## Final release checklist

- `bun run test` passes.
- `bun run build` passes.
- `manifest.json`, `package.json`, and `versions.json` have the same new version.
- Git commit is pushed to `main`.
- Matching semantic version tag is pushed.
- GitHub Actions release workflow passes.
- Release has `main.js`, `manifest.json`, and `styles.css` assets.
- Release assets have artifact attestations.
- Obsidian review shows the latest version and commit.
- Latest review row is completed and passing.
