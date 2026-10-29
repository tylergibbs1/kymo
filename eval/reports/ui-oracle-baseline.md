# UI set: oracle baseline

The scripted oracle on all 87 UI tasks (`bun run eval -- run --model oracle --set ui --split all`), on kymo before and after the round-2 fixes (tracking and easing rewrite, cut, duplicate and drop rules relative to the clip, cadence detection). The oracle reads only kymo's structured results, so every miss below is a question kymo's tools do not yet answer. A test (`test/ui.test.ts`) runs the same tracking strategies with the recorded browser truth as a perfect tracker, and they pass, so the misses come from the tools and not from the strategies.

Run on 2026-10-28. The full run directories are under `eval/reports/runs/` and are not committed.

## Overall

| kymo                 | Dev          | Held out    | All         |
| -------------------- | ------------ | ----------- | ----------- |
| Before round-2 fixes | 24/50 (48%)  | 21/37 (57%) | 45/87 (52%) |
| After round-2 fixes  | 34/50 (68%)  | 30/37 (81%) | 64/87 (74%) |
| After round-3 fixes  | 50/50 (100%) | 36/37 (97%) | 86/87 (99%) |

## By question type

| Family             | Before (dev / held out) | After (dev / held out) |
| ------------------ | ----------------------: | ---------------------: |
| `ui-start`         |               2/7 · 3/7 |              2/7 · 3/7 |
| `ui-settle`        |               1/9 · 3/5 |              1/9 · 3/5 |
| `ui-easing`        |               3/5 · 2/5 |              5/5 · 5/5 |
| `ui-overshoot`     |               4/5 · 2/2 |              5/5 · 2/2 |
| `ui-repeat`        |               0/3 · 1/5 |              3/3 · 5/5 |
| `ui-skip`          |               0/6 · 0/2 |              4/6 · 1/2 |
| `ui-screen-change` |               4/5 · 0/1 |              4/5 · 1/1 |
| `ui-flash`         |               3/3 · 2/2 |              3/3 · 2/2 |
| `ui-safe-area`     |               2/2 · 3/3 |              2/2 · 3/3 |
| `ui-reverse`       |               3/3 · 2/2 |              3/3 · 2/2 |
| `ui-compare`       |               2/2 · 3/3 |              2/2 · 3/3 |

The "after" run allows half a pixel of tracker jitter before calling a tracked box still moving at the last frame. The new tracker's height alternates by 0.06 px at rest, and without that slack `ui-compare-delayed` reads as never settling. The "before" run used the exact check; it changes no "before" result.

## After round 3

Round 3 added change inside a box (`track --props change`), opacity, fixed-scale diff numbers and still trackers, and fixed dropped frames after a hold, flashes read as cuts, and overlays read as cuts. Every family now passes except one `ui-start` task: `ui-snackbar-pulse-start` answers #39 against #35, because the box where the snackbar comes to rest does not contain the path it enters along, so its first frames happen outside the box. The sections below describe the state after round 2.

## What still fails after round 2, and why

### Entrances with no box at 0f (`ui-start`, `ui-settle`): 19 misses

When an element fades in or slides in from off-screen, there is nothing to track at 0f, and kymo has no way to measure motion inside a region. The only signal left is whole-frame motion energy from `scan`, which kymo treats as still below its floor of 0.002. Real UI motion sits under that floor:

| Capture                       | Peak energy | Answer          |
| ----------------------------- | ----------: | --------------- |
| 480x280 dialog, fade and rise |      0.0035 | off by 3 frames |
| 340x64 toast, from off-screen |      0.0017 | nothing found   |
| 180x36 tooltip, fade          |      0.0009 | nothing found   |

So the oracle either finds nothing (12 tasks: tooltips, popovers, toasts) or finds where the energy crosses the floor, several frames inside the true start and end (7 tasks). Distractors make it worse: the scrim (`ui-modal-scrim-settle`, answered #54, truth #43) and the spinner (`ui-modal-spinner-*`) put the whole-frame signal on the wrong thing. All six tasks whose element is visible at 0f pass, because `track` works there; the spring settles pass only within their 11-frame tolerance (`ui-spring-cross-settle` is 7 frames late). Three entrances pass on whole-frame energy alone, where the motion is large and fast enough to clear the floor (`ui-modal-200-snappy-start`, `ui-snackbar-pulse-*`).

Fixes this points to: motion energy restricted to a box (`scan`/`check` with `box`), a stillness floor relative to the clip like the new cut thresholds, or `track` that can start from a box at the last frame (at rest) and run backwards.

### Dropped frame right after a repeat (`ui-skip`): 3 misses

`ui-jank-catchup-skip` (repeat at #25, double step at #26), `ui-jank-many-skip` (#40 then #41, #70 then #71) and `ui-jank-wide-skip` (repeats #35, #36, double step at #64, crf 35). `dropped-frames` finds no drop when the double step follows a repeat directly, presumably because the new cadence detection reads repeat-then-catch-up as one hitch. Isolated drops (`ui-jank-basic`, `pair`, `spinner`, `small-crf35`, `slow`) are found.

### A one-frame flash read as the page change (`ui-screen-change`): 1 miss, new after round 2

`ui-nav-short-crf35-change` answered #61, truth #73: the white flash at #60 comes 12 frames before a 150 ms dissolve, and scan's first cut is now at the flash. The flash question itself (`ui-flash`) still passes. A flash that returns to the same picture is a flicker, not a cut; cut detection could check that the shot after the change differs from the one before it.

### What the round-2 fixes resolved

- Easing (5/10 → 10/10): before, three linear or ease-in motions (two of them on tooltips) were named `spring`, a linear one `ease-out`, and CSS `ease` came back as `ease-in`.
- Repeats (1/8 → 8/8) and drops (0/8 → 5/8): before, the rules were gated on whole-frame motion, and a box stepping 8 px a frame (energy 0.0011) never counted as moving.
- Overshoot (6/7 → 7/7): `ui-overshoot-left-cross`, a card springing left under a translucent banner, now counts 2 reversals as the truth does (it counted 3 before).
- Page change on a dissolve that also slides (`ui-nav-light-slow-change`, `ui-nav-slide-light-change`): these are now found as fades.
