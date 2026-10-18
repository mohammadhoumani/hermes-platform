# Milestone 4 report: the 3D office (items 1 and 2)

This covers the 3D office in the project room and its 2D fallback. Item 3 of M4 (the full end-to-end run and the
demo) is not part of this work. Nothing here talks to a live service. Nothing outside `apps/web` and this file
was changed (`hermes/`, `supabase/`, `template/` and `docs/M2_*` were not touched).

## What was built

- A 3D office in the project room, next to the existing "Who is talking" map. One desk for each of Orchestrator,
  BA, Architect, Coder 1, Coder 2, Devin, Reviewer, QA and Release, a "You" spot, a meeting table and a GitHub
  server rack. Everything is made of boxes, cylinders and spheres in code. There are no model, texture or font files.
- It is driven only by the existing `ViewState` (`lib/agent-events`). There is no new backend, table or event.
- A switch in the room: "3D office" and "Map". The room wiring is one line in
  `components/room/room-client.tsx` (the old panel became `<AgentStage view={view} />`).

### What you see

| ViewState | In the office |
| --- | --- |
| `agents[x] = "active"` | Green glow: screen, desk strip, ring on the floor, floating gem, label `▶` |
| BRD waiting (`gate = "waiting"`) or an agent asked a question | The You spot, its ring and its label turn orange (Texas Rose), the asking agent too, with a bubble that stays until you answer |
| Handoff (`feed` item of kind `handoff`) | The sender walks to the receiver's desk, a small packet flies there, the sender walks back after about 3 seconds |
| Message to GitHub (commit, push, pull request, CI) | A packet flies to the rack and the rack lights blink |
| Review phase with the reviewer active | The reviewer and the coders whose pull request is being checked sit at the meeting table ("Code review") |
| QA phase with QA active | QA and the Orchestrator sit at the meeting table ("QA check") |
| Team sync, replies, bugs, requested changes | Short speech bubbles (70 characters at most, three at a time, gone after 9 seconds) |
| `phase` | A sign on the back wall ("Phase 3 of 6: Development") with six lamps, and a very small change in the light tint |
| `finished` | Nobody walks, nobody sits at the table, everybody is "done" |

Colours are only the brand palette: Caribbean Green for working, Texas Rose for needs you, Steel Gray for the
sign, the rack and the screens, Wafer for the floor and the furniture, Snow for the light background. Labels and
bubbles are HTML that uses the site's own tokens (`bg-primary`, `bg-attn`, `bg-surface` ...), so the pairs that
`lib/contrast.test.ts` already checks are the ones used, in both themes. Status is never colour only: labels have a
glyph (`▶` working, `!` needs you, `✓` done) and, on wide screens, a word.

### Files

All new code is in `apps/web/components/office/`:

| File | What it is |
| --- | --- |
| `layout.ts` | Where every desk, seat, visitor spot and meeting seat is. Plain numbers. |
| `scene-state.ts` | The pure mapping `ViewState -> OfficeScene` (poses, targets, bubbles, packet, meeting, sign, text summary). No three.js, no React, no timers. |
| `capabilities.ts` | The pure decision "3D or map" and the small browser checks (WebGL, reduced motion, weak device, saved choice). |
| `hooks.ts` | `useSyncExternalStore` hooks for the checks, and the clock for walks and bubbles. |
| `agent-stage.tsx` | The panel: toggle, hints, error boundary, live text for screen readers, lazy loading of the canvas. |
| `office-canvas.tsx` | The only file that imports `@react-three/fiber` and drei (`OrbitControls`). Default export, loaded with `next/dynamic` and `ssr: false`. |
| `parts.tsx`, `kit.ts`, `palette.ts` | The 3D pieces, the shared geometries and materials, the colours. |
| `overlay.tsx` | Labels, bubbles and the wall sign (HTML on top of the canvas). |

Also: `apps/web/NOTICE`, `tests/e2e/office.spec.ts`, and the screenshots `docs/screenshots/office-*.png`.

## Decisions

1. **Versions (exact pins).** `three` 0.186.1, `@react-three/fiber` 9.8.2, `@react-three/drei` 10.7.9,
   `@types/three` 0.186.0. Fiber 9 declares `react >=19 <19.4`, and the repo has React 19.3.1; drei 10 needs
   `@react-three/fiber ^9`. No `^` or `~`, same as the rest of the repo. `npm audit --omit=dev` still reports 0 findings.
2. **The map stays the default until 3D is ready.** The server sends the map. After the page loads, the browser is
   checked; if 3D is wanted, the map stays on screen while the 3D chunk downloads (`next/dynamic` `loading`).
   The 3D chunk is a single file of about 952 KB (252 KB gzip). A test proves no script carrying three.js is
   downloaded before the 3D office is opened.
3. **Own labels instead of drei `<Html>`.** Every drei `<Html>` opens its own React root. In React 19 development
   mode each one logs "Attempted to synchronously unmount a root while React was already rendering" (30 messages
   per page; the e2e tests that fail on console errors caught it). `overlay.tsx` keeps one DOM layer and moves the
   elements with one `transform` per frame, only when they moved. drei is still used for `OrbitControls`.
4. **Bubbles for handoffs and replies too, not only Team sync.** Sync messages, questions, replies, bugs, requested
   changes, reviews and handoffs get bubbles. Commits, pushes, CI and file edits do not (too small to talk about);
   they send a packet to the rack instead.
5. **Time lives outside the pure mapping.** `deriveOfficeScene(view, options)` receives `freshAfter`,
   `settledHandoff` and `expiredBubbles` from the component, so a walk that is over or a bubble that has been up for
   9 seconds is decided by the caller. The unit tests use the fixtures and need no timers.
6. **History does not walk.** Only events that arrive while the page is open can make an agent walk or send a
   packet (`freshAfter` is the event number at page load). Opening an old project shows the state as it is, with the
   latest bubbles for a few seconds.
7. **Nobody walks to a desk whose owner is at the meeting table.** They talk there.
8. **Reduced motion.** Starts on the map (with a hint) and 3D can still be opened. Then the scene is still: people
   jump to their place instead of walking, no packet flies, nothing pulses, no camera damping, and the lights change at once.
   A test takes two screenshots 0.9 s apart and checks they are byte-identical.
9. **Weak devices.** `navigator.hardwareConcurrency <= 4` or `navigator.deviceMemory <= 4` starts on the map (with a
   hint). The user can switch, and a saved choice always wins over this rule (but never over "no WebGL").
10. **Choice storage.** `localStorage` key `hermes-office-view` (`3d` or `map`), every read and write in `try/catch`,
    plus a copy in memory so the switch still works for the visit when storage is blocked. It is only saved when the
    user clicks.
11. **Performance.**
    - Geometries (5) and materials (a few dozen) are created once in `kit.ts` and shared. Meshes size themselves with
      `scale`. The server rack lights are one `InstancedMesh`. No shadows (a flat blob under each desk instead).
    - `frameloop="demand"`. Nothing is drawn while nothing happens. A frame is drawn when the scene changes, when
      someone walks, and about 30 times a second while an agent is working (the glow pulse is driven by one timer).
    - `frameloop="never"` while the tab is hidden or the canvas is scrolled out of view (`visibilitychange` and
      `IntersectionObserver`).
    - `dpr={[1, 1.75]}`, `flat` (no tone mapping, so the brand colours stay true), `MeshLambertMaterial` only.
    - No allocation in `useFrame` callbacks (vectors and colours are made once; no `new` or array literals there).
      The one exception is a short `translate3d(...)` string when a label actually moved.
    - The e2e test counts the page's `requestAnimationFrame` calls: at most 6 in 2.5 s for a finished project, and
      clearly more for a project where agents work.
12. **Camera.** `OrbitControls` with no pan beyond the room, rotation limited to about 34 degrees left and right and
    to a band of tilt, zoom between 9 and 42 units, and the distance fitted to the shape of the canvas. Five real
    buttons (Turn left, Turn right, Zoom in, Zoom out, Reset view) do the same from the keyboard.
13. **Accessibility.**
    - The canvas has `role="img"` and an `aria-label` that names everything in the room.
    - A visually hidden `role="status"` element says what is happening now in plain words ("Coder 1 is opening a pull
      request", "Orchestrator is handing work to Coder 1", "Reviewer is asking for changes for Coder 2") and a hidden
      list says what each of the 11 agents is doing. Labels and bubbles are `aria-hidden` (the text is in the summary).
    - The view switch and the camera buttons are plain buttons in the tab order. `aria-pressed` shows the current view.
      "3D office" is disabled with an explanation when WebGL is missing.
    - axe (WCAG 2 A and AA, 2.1 AA, 2.2 AA) passes on the room with the 3D office open, in light and dark.
14. **If 3D breaks, the map comes back.** An error boundary and the `webglcontextlost` event switch to the map with
    "The 3D office stopped working on this device, so the map is shown."
15. **Hermes3D.** I did not fetch or copy anything from it (npm was the only reachable network). `apps/web/NOTICE`
    says so and lists the three MIT libraries.
16. **Left out on purpose.** No sound, no shadows, no external fonts (a drei `<Text>` would fetch a font from a CDN
    at run time), no pointer picking in the scene, no per-agent models.

## Headless Chromium and WebGL (what works)

The container has no GPU. The Chromium from `playwright.base.ts` (`/opt/pw-browsers/chromium`, version 141) gives a
working WebGL 2 context through SwiftShader when it is started with:

```text
--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist
```

`tests/e2e/office.spec.ts` sets them for the whole file with `test.use({ launchOptions })`. (`launchOptions` cannot
be set inside a `describe`, so the one test that needs a browser without WebGL starts its own with
`--disable-3d-apis --disable-gpu --disable-webgl --disable-webgl2`.) Without the flags, the page still works: it
shows the map, which is the fallback working as designed. No `playwright install` was run.

Rendering in software is slow, so the tests never measure speed, only behaviour. The "frames asked for" test uses
relative numbers for that reason.

To look at the office by hand: `HERMES_TEST_MODE=1 npx next dev`, set the cookie `hermes-test-user` to `member`, and
open `/projects/22222222-2222-4222-8222-222222222222`.

## Tests

- **Unit** (`components/office/*.test.ts(x)`, 44 tests, built on the existing fixtures: discovery, calculator run,
  plugin v2 run):
  - the layout (desks, seats, meeting seats are all different);
  - an empty project; the BRD wait (rose You spot, rose BA, bubble that stays, summary text);
  - handoffs (who walks where, who goes home when the walk is settled, history does not walk, reduced motion does not
    walk, packet to GitHub for a pull request);
  - review and QA at the meeting table, an empty table when live, changes requested, nobody walks to an occupied desk;
  - Team sync bubbles (author, length, at most three, one per agent, expiry);
  - phase sign, summary sentences, the list for screen readers, purity (the view is never changed);
  - `decideMode` for every combination, weak-device rules, the saved choice (also with storage that throws);
  - `AgentStage` in jsdom with a stand-in canvas: map first, 3D on a strong device, no WebGL, reduced motion, weak
    device (cores and memory), saving the choice, blocked storage, the screen reader text.
- **Playwright** (`tests/e2e/office.spec.ts`, 21 tests): opens by itself on a strong machine; toggle and remembered
  choice across a reload; no three.js before 3D is wanted; canvas label, live text, tab order of every control;
  axe in both themes; context lost; rose highlight and bubble while the BRD waits; live events (approving the BRD
  sends the BA to the Architect and moves the sign); no sideways scroll at 360 px; stops drawing when hidden and
  draws nothing when idle; no WebGL; reduced motion (still scene); weak device; and the seven screenshots.

Last run, from the worktree:

```text
npm run build            ✓ (11 routes + proxy)
npm run check:bundle     ok: scanned 259 files in .next, no fixture code or data found.
eslint                   no problems
tsc --noEmit             no problems
vitest                   17 files, 310 tests passed (266 before this work, 44 new)
playwright (all)         67 passed (46 existing + 21 office), 4.1 min with 3 workers
```

## Screenshots

In `docs/screenshots/`, taken by `tests/e2e/office.spec.ts` (the panel only, software WebGL):

- `office-waiting-light-desktop.png`, `office-waiting-dark-desktop.png` (BRD waiting: orange You spot and BA)
- `office-building-light-desktop.png`, `office-building-dark-desktop.png` (development: Devin working, GitHub updating)
- `office-live-light-desktop.png` (project live: everybody done)
- `office-building-light-phone.png`, `office-waiting-dark-phone.png` (390 px wide, short labels)

The review table, the QA table and a walk are not in the fixtures that the room can play (the demo backend only
replays up to the Devin step and reacts to approve, message and change request). I checked them by hand with a
temporary page that replayed the calculator fixture event by event (not committed); the unit tests cover the same states.

## What is not verified

- **Frame rate.** The 60 fps desktop and 30 fps mid-phone budget in the plan was not measured. The container only has
  software rendering. What is verified is the design that protects it (on-demand frames, shared GPU objects, DPR cap,
  pause when hidden) and the idle behaviour. Measure on a real laptop and a real mid-range phone.
- **Real GPUs, Safari, Firefox, iOS, Android.** Only Chromium 141 with SwiftShader was used. Touch gestures
  (one finger rotate, two fingers zoom and pan) are OrbitControls defaults and were not tried on a touch screen.
- **Screen reader.** The live text and the list were checked in the DOM and with axe, not with NVDA, VoiceOver or TalkBack.
  How chatty the polite live region is during a fast run is a judgement to make with real use.
- **Live use against a real run.** The office was driven by fixtures and by the test backend's reaction to "approve
  the BRD". It has not seen a real stream of events from the bridge.
- **`THREE.Clock` warning.** With three 0.186 the browser console shows one `console.warn`
  ("THREE.Clock: This module has been deprecated. Please use THREE.Timer instead."). It comes from
  `@react-three/fiber` 9.8.2 itself. Not an error, and it goes away when fiber moves to `THREE.Timer`.
- **Layout.** Desk positions were chosen by eye on desktop and phone screenshots. The walking paths are straight
  lines, so a walker can pass through a desk or a chair (it is low-poly and quick, but it is not path finding).
- **Bundle size.** 252 KB gzip for the lazy chunk is what three.js costs. I did not try to trim drei further
  (`OrbitControls` is the only drei piece used) or compare with a hand-written orbit control.
- **Phase tint.** The tints are very small on purpose, so the wall sign carries the phase. If the product people
  want a stronger change, the numbers are in `palette.ts` (`PHASE_LIGHT`).
