# Investigation: Composer Scroll Moves Extension

## Summary
The root cause is a CSS flex-column overflow containment issue, not JavaScript scrolling the wrong element. AskMate builds `.askmate-messages` as the intended scroll area and all auto-scroll helpers target `this.messagesEl`, but the sidebar root can overflow because it lacks root overflow containment and the message pane has a fixed `min-height: 220px` while composer/workflow controls are non-shrinking siblings.

## Symptoms
- User sends a query in AskMate.
- While the assistant is working or after the query appears, scrolling with the mouse moves the whole extension UI.
- Screenshot shows the composer, context bar, and bottom action controls inside the sidebar area, with a page-level scroll position visible on the right.
- The expected behavior is that scroll should be constrained to the intended message/history region, not shift the entire extension controls.

## Background / Prior Research
No external research needed at initial triage. This appears likely to be local DOM structure, scroll-container, wheel event, or CSS overflow behavior in the Obsidian plugin.

## Investigator Findings
<!-- The pair investigator appends structured analysis here with file:line refs, evidence, and conclusions. -->

### 2026-05-12 Read-only investigation

#### Executive conclusion

The leading hypothesis is supported. AskMate intends `.askmate-messages` to be the vertical scroll container, and the TypeScript scroll helpers consistently target `messagesEl`. I found no `wheel` handler, no `overscroll` rule, and no JavaScript that scrolls the sidebar root. The most likely cause is CSS flex overflow: `.askmate-sidebar` is a height-constrained flex column with no overflow containment, `.askmate-messages` has `overflow-y: auto` but also `min-height: 220px`, and the composer, request preview, extra context controls, and workflow section are non-shrinking siblings that can consume more vertical space than the sidebar has available.

#### Concrete evidence

- DOM construction order is messages, workflow panel, then composer:
  - `main.ts:6355-6358` takes `this.containerEl.children[1]`, empties it, and adds `askmate-sidebar` to that Obsidian container.
  - `main.ts:6384-6388` creates `this.messagesEl = container.createDiv({ cls: "askmate-messages" })` and registers the only message scroll listener on that element.
  - `main.ts:6391-6392` renders the workflow grid and composer after the messages element.
  - `main.ts:6410-6412` creates `.askmate-workflow-section` as a direct child of the sidebar container.
  - `main.ts:6527-6528` creates `.askmate-composer` as a direct child of the sidebar container.
- Send flow grows the message history inside `.askmate-messages`:
  - `main.ts:7054-7073` clears the textarea and calls `runRequest()` after submit.
  - `main.ts:7150-7154` sets `shouldFollowMessages = true` and adds the user message.
  - `main.ts:7197-7205` may add context image previews, then creates the assistant message.
  - `main.ts:7212-7214` streams text into the assistant message and calls `maybeScrollMessagesToBottom()` on every delta.
  - `main.ts:7225-7230` renders final markdown and appends assistant actions.
  - `main.ts:7255-7258` renders generated image responses inside the assistant message.
  - `main.ts:7303-7305` appends normal chat messages through `createMessageEl()`.
  - `main.ts:7314-7316` creates each message wrapper under `this.messagesEl`, not under the sidebar root.
- Scroll helpers and event handling target the intended element:
  - `main.ts:6386-6388` listens for `scroll` on `this.messagesEl` and updates follow state from `isScrolledNearBottom()`.
  - `main.ts:7870-7875` only auto-scrolls when `shouldFollowMessages` is true.
  - `main.ts:7878-7881` calculates near-bottom state from `this.messagesEl.scrollHeight`, `scrollTop`, and `clientHeight`.
  - `main.ts:7884-7885` sets `this.messagesEl.scrollTop = this.messagesEl.scrollHeight`.
  - Repository search found no `wheel` handler and no `overscroll` usage in `main.ts` or `styles.css`. The only other sidebar-adjacent registered events are `pointerdown` and `focusin` on the root for context refresh at `main.ts:6402-6403`, not scrolling.
  - The unrelated `editor.scrollIntoView()` at `main.ts:4681` is used for opening evidence in the Markdown editor, not for the AskMate sidebar.
- CSS makes the root a flex column but does not contain root overflow:
  - `styles.css:1-15` defines `.askmate-sidebar` with `display: flex`, `flex-direction: column`, `gap: 8px`, `height: 100%`, `min-width: 0`, and padding. It does not set `overflow: hidden` or `min-height: 0`.
  - `styles.css:85-94` defines `.askmate-messages` with `flex: 1 1 auto`, `min-height: 220px`, `overflow-y: auto`, and thin scrollbars. This is the intended scroll pane, but the 220 px minimum prevents it from shrinking below that height when sibling content grows.
  - `styles.css:708-718` defines `.askmate-composer` with `flex: 0 0 auto`, so the composer does not shrink when vertical space is tight.
  - `styles.css:580-591` defines `.askmate-workflow-section` with `flex: 0 0 auto`, so the workflow panel also does not shrink when visible.
- Composer and preview can consume enough height to force root overflow:
  - `main.ts:6527-6608` composes header, input shell, optional request preview, footer actions, output toggle, and reasoning selector inside `.askmate-composer`.
  - `main.ts:6610-6629` inserts `.askmate-request-preview` inside the composer when the setting is enabled.
  - `main.ts:6676-6737` adds an expandable `.askmate-extra-context-controls` details block containing a textarea, checkbox, text input, and number input.
  - `styles.css:977-988` gives `.askmate-question` `min-height: 68px`, `resize: vertical`, and full width. User resizing can permanently increase composer height.
  - `styles.css:720-727` makes the expanded composer layout larger, including a 112 px textarea minimum.
  - `styles.css:1349-1358` styles `.askmate-request-preview` as a flex column with margin, padding, and no max-height or overflow.
  - `styles.css:1369-1372` lets request preview controls wrap, which adds rows in narrow sidebars.
  - `styles.css:1399-1438` gives extra context controls and their body layout, with no max-height or overflow cap.
- Message content is mostly inside the intended pane, but depends on that pane being allowed to shrink:
  - `main.ts:7539-7568` renders generated images inside a message body.
  - `styles.css:290-295` bounds generated images by width only, with `max-width: 100%` and no `max-height`, so a generated image can make `.askmate-messages` content very tall.
  - `main.ts:7360-7422` renders context image previews inside a system message.
  - `styles.css:335-339` caps context preview images with `max-height: 220px`, so these are less risky than generated images.
  - `main.ts:7667-7700` renders Markdown into `.askmate-rendered-markdown` and then auto-scrolls messages.
  - `styles.css:379-381` uses `overflow-wrap: anywhere` for Markdown, `styles.css:441-445` makes tables horizontally scrollable, and `styles.css:462-466` makes code blocks horizontally scrollable. Wide content is handled horizontally, while tall content still relies on `.askmate-messages` vertical scrolling.
- Responsive rules do not fix the vertical overflow path:
  - `styles.css:1318-1348` only adjusts padding, workflow grid column width, and output control layout for narrow sidebars. It does not reduce `.askmate-messages` minimum height, cap composer or workflow height, or add root overflow containment.

#### Causal chain

1. `AskMateView.onOpen()` makes the Obsidian view child the `.askmate-sidebar` root and places `.askmate-messages`, `.askmate-workflow-section`, and `.askmate-composer` as vertical flex siblings.
2. `.askmate-sidebar` has `height: 100%`, but no `overflow: hidden` and no `min-height: 0`, so if child heights exceed the available height, the root can overflow instead of clipping to the view.
3. `.askmate-messages` is the intended scroll container, but its `min-height: 220px` prevents it from shrinking enough when the composer, request preview, extra context controls, textarea resizing, expanded layout, or workflow grid consume vertical space.
4. The composer and workflow section are `flex: 0 0 auto`, so they keep their intrinsic height and push the total flex column height past the available sidebar height.
5. After a user sends a query, messages and assistant content grow, but the root layout may already be over-constrained by the composer and controls. Mouse-wheel scrolling then scrolls the nearest scrollable ancestor, which can be the Obsidian/sidebar view, causing the whole AskMate UI to move rather than only `.askmate-messages`.

#### Eliminated or lower-confidence hypotheses

- JavaScript scrolling the wrong element: eliminated. All AskMate auto-scroll helpers read or write `this.messagesEl`; no helper targets `rootEl`, `container`, `containerEl`, or the composer.
- Wheel-event bug: eliminated in plugin source. No `wheel` listener exists in `main.ts`, and no CSS `overscroll` rule exists in `styles.css`.
- Markdown table or code width causing the whole extension to move: low confidence. Tables and code blocks have horizontal overflow handling in `styles.css:441-445` and `styles.css:462-466`.
- Context image preview height as the primary trigger: lower confidence. Context preview images are capped at `max-height: 220px` in `styles.css:335-339`, though they still add vertical content inside messages.
- Generated images as the only trigger: lower confidence. Generated images can be tall because `.askmate-generated-image` lacks `max-height`, but they render inside `.askmate-messages`; they become a root-scroll symptom mainly when the message pane cannot shrink because of the flex and min-height constraints.

#### Recommended fix locations

- Primary CSS fix in `styles.css`:
  - Add overflow containment and shrink permission to `.askmate-sidebar` at `styles.css:1-15`, likely `min-height: 0` and `overflow: hidden`.
  - Change `.askmate-messages` at `styles.css:85-94` so it can shrink inside the flex column, likely replace `min-height: 220px` with `min-height: 0`, or use a much smaller responsive minimum if a design minimum is required.
- Secondary CSS hardening in `styles.css`:
  - Consider adding `overscroll-behavior: contain` to `.askmate-messages` at `styles.css:85-94` to reduce scroll chaining once it reaches its edges.
  - Consider capping `.askmate-composer`, `.askmate-request-preview`, or `.askmate-extra-context-controls` near `styles.css:708-718`, `styles.css:1349-1358`, and `styles.css:1399-1438`, with internal overflow if expanded controls must remain usable in short sidebars.
  - Consider adding a `max-height` to `.askmate-generated-image` at `styles.css:290-295` so image responses cannot dominate the message pane.
- TypeScript fix is probably not needed for the root cause:
  - `main.ts:6384-6388` and `main.ts:7870-7885` already target `.askmate-messages` consistently.
  - If a defensive JS fix is desired later, add a targeted wheel containment handler on `.askmate-messages`, but CSS containment should be the first fix because the current failure comes from an over-constrained flex layout.

#### Validation notes

- This was a read-only source investigation. I did not run or modify the plugin UI.
- Source code was not changed. Only this investigation report was edited.
- Existing working tree status before editing the report showed `main.ts` and `styles.css` already modified, so line refs reflect the current workspace contents at investigation time.

#### Confidence

High, about 0.85. The code evidence strongly supports CSS/flex overflow as the primary cause and rules out plugin-level JS wheel or wrong-scroll-target behavior. Remaining uncertainty is from not reproducing inside Obsidian, where parent pane styles may affect which ancestor receives the wheel scroll.

## Investigation Log

### Phase 1 - Initial Assessment
**Hypothesis:** After a message is submitted, AskMate appends chat/history content into a container whose overflow or height constraints allow the plugin root/sidebar to become the scroll container. Mouse wheel events then scroll the entire extension instead of a bounded conversation area.
**Findings:** Initial symptom points to CSS layout and render flow around the AskMate sidebar root, message/history pane, composer, loading state, and scroll handling.
**Evidence:** User-provided screenshot shows the whole sidebar UI shifted with a visible outer scrollbar, and the report says scrolling after sending a query moves the whole extension.
**Conclusion:** Proceeded to Context Builder for workspace discovery before deeper investigation.

### Phase 2 - Context Builder
**Hypothesis:** The intended message scroll pane is not reliably bounded because the flex parent and flex child are over-constrained.
**Findings:** Context Builder selected `main.ts`, `styles.css`, the investigation docs, and project metadata. Its initial analysis identified `.askmate-sidebar` and `.askmate-messages` as the highest-risk CSS areas.
**Evidence:** `.askmate-sidebar` is a flex column with `height: 100%`, no `overflow: hidden`, and no `min-height: 0`. `.askmate-messages` is intended to scroll, but uses `min-height: 220px`.
**Conclusion:** Confirmed the main investigation should focus on CSS flex overflow and rule out JS scroll targeting.

### Phase 3 - Pair Investigation
**Hypothesis:** CSS flex overflow causes an ancestor scroll container to own wheel scrolling after message and composer content grows.
**Findings:** Pair investigator verified DOM order, send flow, scroll helpers, and CSS constraints. It found no plugin `wheel` handler, no `overscroll` rule, and no JavaScript helper that scrolls the sidebar root.
**Evidence:** See `## Investigator Findings`, especially `main.ts:6355-6388`, `main.ts:6527-6639`, `main.ts:7197-7226`, `main.ts:7870-7885`, `styles.css:1-15`, `styles.css:85-94`, `styles.css:580-591`, and `styles.css:708-718`.
**Conclusion:** Confirmed CSS/flex overflow as the likely root cause with high confidence.

### Phase 4 - Oracle Synthesis
**Hypothesis:** The CSS/flex explanation is sufficient, with scroll chaining as a secondary concern.
**Findings:** Oracle agreed that the root cause is flex-column overflow containment, not JavaScript scrolling the wrong element. It identified scroll chaining, Obsidian parent pane behavior, composer height amplification, and large message rendering as secondary factors.
**Evidence:** Verified line references from `main.ts` and `styles.css` were provided to Oracle after spot-checking.
**Conclusion:** Final report should recommend CSS-first fixes, with JS wheel containment only as a fallback.

## Root Cause
The root cause is a flex-column overflow containment issue in the AskMate sidebar layout.

`AskMateView.onOpen()` creates the Obsidian view child as the AskMate root, then renders `.askmate-messages`, the workflow section, and the composer as vertical siblings. `main.ts:6355-6388` creates `.askmate-sidebar` and `.askmate-messages`, and `main.ts:6391-6412` renders workflow grid and composer after the message pane. `main.ts:6527-6639` places the composer, request preview, and extra context controls inside the non-message part of the layout.

The TypeScript scroll logic targets the intended element. Messages are created under `this.messagesEl` at `main.ts:7303-7316`, streamed assistant text updates the assistant body and calls `maybeScrollMessagesToBottom()` at `main.ts:7197-7226`, and the scroll helpers at `main.ts:7870-7885` only use `this.messagesEl.scrollTop`, `scrollHeight`, and `clientHeight`. Repository search found no plugin `wheel` handler and no `overscroll` usage.

The failure is in CSS containment. `styles.css:1-15` gives `.askmate-sidebar` `display: flex`, `flex-direction: column`, `height: 100%`, padding, and gap, but it does not set `min-height: 0` or `overflow: hidden`. `styles.css:85-94` makes `.askmate-messages` the intended scroll pane with `overflow-y: auto`, but also forces `min-height: 220px`. `styles.css:580-591` and `styles.css:708-718` make the workflow section and composer `flex: 0 0 auto`, so they keep their intrinsic height instead of shrinking when vertical space is tight.

After the user sends a query, message content grows inside `.askmate-messages`, while composer controls, request preview, expanded layout, extra context controls, and textarea resizing can consume fixed vertical space outside the message pane. In a short or narrow Obsidian sidebar, the total required height can exceed the available pane height. Because the AskMate root does not contain overflow and the message pane cannot shrink below 220px, the Obsidian/sidebar parent can become the scroll owner. Mouse-wheel input then moves the whole AskMate UI instead of only the intended message history area.

### Eliminated Hypotheses
- JavaScript scrolling the wrong element is eliminated. All AskMate auto-scroll helpers target `this.messagesEl`, not the sidebar root or composer.
- A plugin wheel-event bug is eliminated in the current source. Search found no `wheel` listener in `main.ts` and no `overscroll` rule in `styles.css`.
- Markdown tables or code blocks causing vertical root movement is low confidence. They have horizontal overflow handling in `styles.css:441-445` and `styles.css:462-466`.
- Context image previews are not the primary trigger. Preview images are capped with `max-height: 220px` in `styles.css:335-339`.
- Generated images can amplify the symptom because `.askmate-generated-image` has no max height at `styles.css:290-295`, but they render inside `.askmate-messages` and should remain contained once the flex layout is bounded.

## Recommendations
1. Fix `styles.css:1-15` first by making `.askmate-sidebar` a bounded non-scrolling flex root.

```css
.askmate-sidebar {
	min-height: 0;
	overflow: hidden;
}
```

2. Fix `styles.css:85-94` by allowing `.askmate-messages` to shrink to the remaining space and remain the only vertical scroll pane.

```css
.askmate-messages {
	flex: 1 1 0;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
}
```

3. Treat scroll chaining as secondary hardening. `overscroll-behavior: contain` on `.askmate-messages` should reduce wheel propagation when the message pane reaches its scroll boundaries, but it should not replace the root flex containment fix.
4. If short sidebars still overflow, cap or internally scroll composer-adjacent controls near `styles.css:708-718`, `styles.css:1349-1358`, and `styles.css:1399-1438`, especially request preview and expanded extra context controls.
5. Consider limiting vertical textarea growth at `styles.css:977-988` or adding a max composer height if user-resized textareas can starve the message pane.
6. Consider adding a `max-height` to `.askmate-generated-image` at `styles.css:290-295` so image outputs cannot dominate the scroll pane.
7. Only add JavaScript wheel containment if CSS fixes do not fully resolve scroll chaining. The root cause is layout containment, so JS should be a fallback.

## Fix Applied
The recommended CSS containment fix has been applied after the read-only investigation:

- `styles.css:1-18` now gives `.askmate-sidebar` `min-height: 0` and `overflow: hidden`.
- `styles.css:87-97` now gives `.askmate-messages` `flex: 1 1 0`, `min-height: 0`, and `overscroll-behavior: contain`.
- `scripts/roadmap-smoke-tests.ts` now asserts both scroll-containment CSS snippets remain present.

Validation completed:

```text
bun run test
bun run build
```

Both commands passed.

## Preventive Measures
- Add a manual UI regression checklist for composer scrolling: narrow right sidebar, short right sidebar, compact layout, expanded layout, request preview enabled, extra context opened, workflow grid opened, long Markdown response, code block/table response, generated image response, and mouse-wheel over both message pane and composer.
- Add a smoke assertion or lightweight CSS regression check that `.askmate-sidebar` contains overflow and `.askmate-messages` can shrink inside the flex column.
- Avoid fixed minimum heights on the primary scroll child of a constrained flex column unless the parent explicitly contains overflow and sibling controls are capped.
- Prefer CSS scroll containment before JS wheel interception for Obsidian sidebar panels.
