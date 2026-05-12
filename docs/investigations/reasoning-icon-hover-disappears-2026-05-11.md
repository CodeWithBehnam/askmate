# Investigation: Reasoning Icon Disappears On Hover

## Summary
The reasoning icon is not being removed by JavaScript. It sits underneath a full-size transparent native `<select>` overlay, and that top select layer can visually cover or neutralize the icon during hover or focus while the circular shell remains visible.

Confidence is high for the stacking and native select overlay root cause. Disabled or theme color contrast is a plausible secondary contributor in image-model or loading states.

## Symptoms
- Hovering the reasoning icon changes it from a visible icon in a circular button to an empty or nearly empty circle.
- The screenshots suggest the circular button remains visible while the inner icon is no longer visible.

## Background / Prior Research
No external research needed at initial triage. This appears likely to be local UI styling or icon rendering behavior in the Obsidian plugin.

## Investigator Findings
<!-- The pair investigator appends structured analysis here with file:line refs, evidence, and conclusions. -->

### 2026-05-11 Read-only investigation

#### Scope
Investigated the reasoning selector DOM, update flow, hover/focus/disabled CSS, stacking rules, and whether JavaScript removes or recreates the brain icon during hover or focus. No source files were changed.

#### DOM creation and update flow
- `main.ts:2760-2761` stores the native select and its visual shell separately as `reasoningSelectEl` and `reasoningControlEl`.
- `main.ts:2798-2799` resets both references when the view opens, then the composer is rendered through `renderComposer()` and `renderOutputToggle()`.
- `main.ts:2994` calls `renderReasoningSelector(controls)` as part of the output control row.
- `main.ts:3022-3026` creates the control as a `div.askmate-reasoning-shell.askmate-icon-select-control`, inserts the visible `brain` icon first with class `askmate-reasoning-icon`, then creates a child native `<select class="askmate-reasoning-select">` after the icon.
- `main.ts:3030-3039` populates the select options. `main.ts:3040-3042` registers only a `change` handler on the select, which calls `selectReasoningEffort(select.value)`.
- `main.ts:3044-3046` stores the shell and select references, then calls `refreshReasoningSelector()`.
- `main.ts:3061-3088` refreshes value, disabled state, title, aria label, `is-disabled`, and `aria-disabled`. It does not empty the shell, call `setIcon`, remove the icon, or recreate the selector.
- `main.ts:3680-3705` calls `refreshReasoningSelector()` from `setLoading()`, so active requests can toggle the disabled state, but this path also does not mutate the icon node.

#### Hover and focus event handling
- `main.ts:2825-2826` registers sidebar-level `pointerdown` and `focusin` handlers that refresh context and call `refreshReasoningSelector()` via `refreshContext()` at `main.ts:2818-2822`.
- `main.ts:3040-3042` is the only event handler attached directly to the reasoning select in the creation path.
- I found no reasoning-specific `mouseenter`, `mouseover`, `mouseleave`, `mouseout`, `pointerenter`, `pointerover`, `focus`, `blur`, or hover handler that removes, hides, empties, or recreates `.askmate-reasoning-icon`.
- Conclusion: the disappearing icon is not caused by JavaScript removing the icon on hover/focus. Focus can trigger a refresh, but the refresh only updates select and shell attributes/classes.

#### CSS evidence: stacking and native select overlay
- `styles.css:632-647` gives `.askmate-reasoning-shell` the same 32px circular layout as the adjacent controls and makes it `position: relative`, which establishes the containing block for absolutely positioned children.
- `styles.css:665-670` changes the shell background and color on hover when it is not disabled. This rule should make the icon inherit `var(--text-normal)`, so ordinary enabled hover does not explain an icon becoming transparent or removed.
- `styles.css:690-702` styles `.askmate-reasoning-icon` and its `svg` only for flex centering, pointer-event suppression, and 14px sizing. It does not give the icon `position`, `z-index`, explicit `color`, opacity, or a protected stacking layer.
- `styles.css:704-705` sets `.askmate-reasoning-shell { overflow: hidden; }`, so any native control paint inside the 32px pill is clipped to the circular shell.
- `styles.css:717-734` makes `.askmate-reasoning-select` a transparent native select, removes native appearance where supported, sets `height: 100%`, `width: 100%`, `inset: 0`, `position: absolute`, and `z-index: 2`.
- Because `main.ts:3024-3026` inserts the icon before the select, and the select has `position: absolute` plus `z-index: 2` while the icon has no z-index, the select is painted above the visible brain icon across the full shell. This confirms the overlay portion of the initial hypothesis.
- The overlay is transparent at rest (`styles.css:720-724`), which explains why the icon can be visible normally even though the select is on top. On hover/focus, browser or Obsidian theme native select rendering can paint focus, hover, text, or control chrome inside that top layer, visually neutralizing the icon without removing it from the DOM.
- `styles.css:539-545` adds a focus ring to `.askmate-icon-select-control:focus-within`, so focusing the overlaid select has a visible shell effect, but no corresponding rule lifts the icon above the focused select.

#### CSS evidence: disabled and theme color contributors
- `main.ts:3077-3088` disables the select and adds `.is-disabled` to the shell when the selected model is an image model or while a request is loading.
- `styles.css:708-715` applies `opacity: 0.55` to the whole reasoning shell in disabled state and changes the reasoning icon color to `var(--text-faint)`.
- `styles.css:679-683` and `styles.css:737-739` only change cursor behavior for disabled controls, not visibility.
- Conclusion: disabled/theme state is a plausible secondary contributor to low contrast, especially on themes where `--text-faint` is very close to the shell background. It does not by itself explain an enabled hover-only disappearance, because the enabled hover rule at `styles.css:665-670` changes color to `var(--text-normal)`.

#### Global SVG, select, and grouped button rules checked
- The only reasoning icon SVG sizing rule is `styles.css:698-702`. It does not hide or recolor the SVG.
- Other SVG sizing rules are scoped to unrelated icons, such as `.askmate-logo svg` at `styles.css:45-48`, `.askmate-workflow-icon svg` at `styles.css:560-562`, and `.askmate-action-icon svg` at `styles.css:813-816`.
- Grouped button sizing and responsive rules include the reasoning shell at `styles.css:632-647` and `styles.css:1110-1115`, but these preserve 32px sizing and do not remove the icon.
- I did not find plugin CSS that sets `.askmate-reasoning-icon` or `.askmate-reasoning-icon svg` to `display: none`, `visibility: hidden`, or `opacity: 0`.

#### Hypothesis status
- Confirmed, strongest: the native `.askmate-reasoning-select` is a full-size absolutely positioned overlay above the icon (`styles.css:717-734`) and the icon has no protective stacking/color layer (`styles.css:690-702`). This can make hover/focus paint from the top select layer cover or visually neutralize the icon while leaving the circular shell visible.
- Weaker but possible: disabled/theme state can reduce icon contrast via shell opacity and `--text-faint` (`styles.css:708-715`), especially when `main.ts:3077-3088` marks the control disabled for image models or loading requests.
- Ruled out: JavaScript hover/focus removal or recreation of the icon. The creation path adds the icon once (`main.ts:3022-3026`), direct reasoning events only handle `change` (`main.ts:3040-3042`), and refresh paths update attributes/classes without removing the icon (`main.ts:3061-3088`, `main.ts:3680-3705`).
- Mostly ruled out: an explicit plugin hover rule hiding the icon. The hover rule for enabled reasoning controls changes color to normal text (`styles.css:665-670`), and the reasoning icon rules do not set visibility or opacity (`styles.css:690-702`).

#### Likely root cause
The visible brain icon is underneath an invisible full-shell native select overlay. At rest the overlay is transparent, so the icon shows through. On hover or focus, the top select layer can paint native select hover/focus/control affordances, or theme-provided select styling, over the icon. Since the icon has no `position`/`z-index` and no explicit color pinning, it is not protected from that overlay. Disabled state can further lower contrast, but it appears secondary to the stacking order.

#### Recommended fix locations
- Primary fix in `styles.css` near `styles.css:690-734`: put `.askmate-reasoning-icon` above the overlay, for example by giving it `position: relative`, a higher `z-index` than the select, and an explicit `color: currentColor` or desired token. Keep `pointer-events: none` so the select remains clickable.
- Alternative fix in `styles.css` near `styles.css:717-734`: keep the select clickable but move it behind the icon or reduce its native painted area. This is riskier because the select must still receive pointer events across the 32px shell.
- Disabled-state hardening in `styles.css` near `styles.css:708-715`: avoid combining whole-shell opacity with `--text-faint` for the icon, or set a minimum contrast token for disabled icons.
- Optional DOM hardening in `main.ts:3022-3026`: if CSS stacking is not reliable across Obsidian themes, create a separate icon layer with a predictable class and stack order while leaving the select as the interactive layer.


## Investigation Log

### Phase 1 - Initial Assessment
**Hypothesis:** The reasoning icon disappears due to a hover CSS rule, icon color inheritance, opacity, mask rendering, or button state class applied around the reasoning effort selector.
**Findings:** Initial search found reasoning UI and icon-related code in `main.ts`, with likely related styling in `styles.css`.
**Evidence:** User-provided screenshots show the container remains visible, but the inner icon disappears on hover.
**Conclusion:** Proceeding to Context Builder for workspace discovery.

## Root Cause
The reasoning selector is built as a circular shell containing a visible icon followed by a native select. In `main.ts:3022-3026`, the shell is created, `addIcon(shell, "brain", "askmate-reasoning-icon")` inserts the visible icon, and then `shell.createEl("select", { cls: "askmate-reasoning-select" })` inserts the select after it.

The CSS then places the select above the icon. `styles.css:716-734` makes `.askmate-reasoning-select` absolute, full-size, transparent, and `z-index: 2`. The icon rules in `styles.css:690-714` only center and size the icon and SVG. They do not give the icon `position`, `z-index`, explicit stroke, opacity, or a protected visual layer.

At rest, the transparent select lets the icon show through. On hover or focus, native select rendering, Obsidian theme styling, or browser control painting can occur on the top layer. That makes the inner icon appear to disappear while the circular shell and border remain visible. The shell remains visible because its own hover and focus styles still apply at `styles.css:656-670` and `styles.css:536-540`.

### Eliminated Hypotheses
- JavaScript hover removal is eliminated. The select creation path only attaches a `change` handler at `main.ts:3040-3042`.
- Refresh logic removing or recreating the icon is eliminated. `main.ts:3061-3088` updates select value, disabled state, titles, ARIA labels, `.is-disabled`, and `aria-disabled`, but does not remove or recreate the icon.
- Loading state mutating icon markup is eliminated. `main.ts:3679-3707` calls `refreshReasoningSelector()` during loading changes, but does not touch the icon DOM.
- Plugin hover CSS intentionally hiding the icon is mostly eliminated. The enabled hover rule changes the shell to `color: var(--text-normal)`, which should improve contrast rather than hide the icon.
- Disabled state is not the primary explanation for enabled hover-only disappearance. It can reduce contrast through shell opacity and `var(--text-faint)`, so it should be treated as a secondary hardening issue.

## Recommendations
1. In `styles.css` near the `.askmate-reasoning-icon` and `.askmate-reasoning-select` rules, give the icon a protected visual layer above the select while keeping `pointer-events: none` so the select remains clickable.

```css
.askmate-reasoning-icon {
	position: relative;
	z-index: 3;
	color: currentColor;
}

.askmate-reasoning-icon svg {
	stroke: currentColor;
}

.askmate-reasoning-select {
	z-index: 2;
}
```

2. Test the same states after the CSS layering change: idle text model, hover, focus, loading request, and `gpt-image-2` selected.
3. If the icon still disappears in some Obsidian themes, replace the invisible native select overlay with a button-triggered dropdown or menu pattern so native select painting cannot cover the visual icon.
4. Harden disabled contrast separately near `styles.css:716-727`, avoiding the combination of whole-shell opacity and `var(--text-faint)` if it makes the disabled icon unreadable.

## Preventive Measures
- Avoid placing transparent native form controls above visible icons unless the visual layer has an explicit stacking order and color contract.
- For icon controls implemented with overlaid inputs or selects, require a CSS review for `z-index`, `pointer-events`, focus state, hover state, and disabled contrast.
- Add a manual UI regression checklist for composer controls covering hover, focus, active request, disabled image-model state, and at least one non-default Obsidian theme.
- Prefer explicit SVG color inheritance rules for Obsidian `setIcon()` icons in compact interactive controls.
