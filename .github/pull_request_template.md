## Summary

<!-- What changed and why? -->

## Type of Change

- [ ] Bug fix
- [ ] Feature
- [ ] Documentation
- [ ] Refactor
- [ ] Release or packaging

## Validation

- [ ] `bun run lint`
- [ ] `bun run typecheck:tests`
- [ ] `bun run test`
- [ ] `bun run build`
- [ ] Manual Obsidian check, if UI or plugin behaviour changed

## Manual Checks

<!-- Describe what you tested in Obsidian, if applicable. -->

## Screenshots or Demo

<!-- Add screenshots, GIFs, or notes for UI changes. -->

## Risk Notes

<!-- Mention privacy, provider, Apply safety, context capture, or migration risks. -->

## Checklist

- [ ] README and `docs/` updated, if behaviour changed
- [ ] Settings migration considered, if settings changed
- [ ] Apply safety preserved, including no-selection append behaviour, if output/editing changed
- [ ] Provider privacy and SecretStorage behaviour preserved, if provider code changed
- [ ] MCP stays off by default, tools never write to the vault, and `child_process` stays in `src/mcp/launch.ts`, if MCP code changed
- [ ] Model, skill and tool text is still sanitised before it renders or is written, if output code changed
- [ ] Release assets considered, if this is a release change
