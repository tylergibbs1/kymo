---
name: kymo
description: See and measure motion in video files, UI animations, live feeds and telemetry with the kymo CLI or MCP tools. Use when asked what happens in a clip, when something moves, flickers, cuts or drops frames, how an animation is eased or timed, or to prove an animation change worked.
---

# kymo

kymo turns any moving source into a Timeline: frames and numeric tracks on one clock. Every frame has one address, and that address is the same in image labels, JSON and filenames, so pass back exactly what you see.

## Addresses

| Form                      | Meaning                                        |
| ------------------------- | ---------------------------------------------- |
| `08s10f`                  | 8 seconds 10 frames (canonical timecode)       |
| `#250`                    | frame index 250 (exact; good for arithmetic)   |
| `8.33s`, `500ms`          | a time, rounded to the nearest frame           |
| `-1f`, `-2s`              | counted from the end (`-1f` is the last frame) |
| `@impact1`, `@cut1+5f`    | a marker, optionally offset                    |
| `2s..4s:2f`, `#0..#90:10` | a range with an optional step                  |
| `clip1@08s10f`            | an address on a specific source                |

Labels show both forms: `08s10f #250`. Quote either back. Timecodes keep the units between their first and last segment, so `02m00s24f` is 2 minutes and 24 frames (never `02m24f`).

On variable-frame-rate sources (`vfr: true`: phone and screen recordings, GIFs), seconds are real time and frames are decoded frames: `16s` and `8.33s` are the frames on screen then, `5f`, `-1f` and `@cut1+5f` count frames, and labels show each frame's start time (`16.04s #350`).

## The loop

1. **probe** the source: fps, duration, size, tracks, markers. Cheap, no images. `as=hero` names it; a name already used for another source is refused (pass `replace` to rebind it and drop its markers).
2. **scan** with a small budget (6–12) for an overview. Use `sample=motion` to spend frames where things change; cuts take at most half the budget, and any left out are named in `note`. Read the motion-energy summary and the suggested next ranges. Scan saves what it finds as markers on the source (`@cut1`, `@peak1`), so later calls can address them. A saved marker never moves or changes name: a later scan, ranged or not, reports a cut it already knows under its old name and numbers new ones after the highest. A cut's `incoming` is the first frame showing the new shot (for a fade, the first measurably mixed frame); its `address` is the middle of a fade. A flash (a frame, or up to 1/15 s, unlike both sides, such as a white frame) is not a cut and is listed apart in `flashes`, so a fade cut near a flash is a real transition; `check --rules flicker` rates it. Nor is something drawn over an unchanged page, such as a dimming backdrop or a dialog, a cut.
3. **frames** at the interesting addresses. Pick the view for the question:
   - `sheet`: what happens at these moments
   - `onion`: path and spacing of a motion (easing, arcs)
   - `diff`: what changed between consecutive frames, and where. The diff at N compares N with N−1, so the frame where something reaches its final state is the **last** frame with change, not the first frame without. The heatmap's scale is fixed: black is change under the noise floor (in the sheet label, at least 5 luma steps), white a full-scale change, so encoder noise never looks like motion. `diff.frames` gives each frame's `changedFraction` (0 = nothing changed); pass `box` to measure inside one region. Pass `against` (one address, e.g. `-1f` or `0f`) to compare every frame with that frame instead: against `-1f`, the first frame from which every `changedFraction` is 0 is where the picture reaches its final look. For numbers alone over a long range, pass `numbersOnly` (`--numbers-only`): no images, so the 100-frame cap does not apply (up to 1000 frames).
   - `follow`: one region up close over time
   - `grid`: rough on-screen position (orientation only; never read coordinates off pixels when a track exists)
4. **track** or **check** for numbers. Prefer measured numbers over estimates from pixels:
   - `check` runs lint rules (flicker, dropped/duplicate frames, black frames, safe area, non-monotonic curves; a frame that jumps two steps right after a held frame is a dropped frame too, and a multi-frame finding's `span` lists every frame it covers; a flicker over a quarter of the frame or more is an error, a smaller blink a warning, however light the page) and assertions such as `box.x <= 600 at 1s` or `@impact1 within #40..#50`. On footage, pass `box` the same way to check the safe area and assert on `box.x`/`.y`/`.w`/`.h`: `kymo check clip1 --box 120,80,64,64 --rules safe-area --assert "box.x <= 554 at #60"`, or `box.change == 0 after 40f` to prove a region has stopped changing. `--rules non-monotonic` with `box` checks the box's `box.x` and `box.y` for a step back (more than 1 px); `tracks` picks which, e.g. `--tracks box.x`. To read a value, use `track`, not a failing assertion. `safeMargin` is 0.05 (action-safe) by default; use 0.1 for title-safe.
   - `track` returns keyframes (where a value starts, stops and reverses, at exact frames) and an optional easing fit; pass `format=detailed` for every frame. A `box` must be where the subject is at the **first frame of the range**, or at `anchor` when given; `lost` lists frames where it was lost (`edge` when it is mostly past the frame edge, `faded` when it faded out or is hidden, `low-confidence` otherwise). For something that fades or slides in, box it where it is fully visible and track backwards: `range=30f..12f` (anchor is 30f), or pass `anchor` inside a forward range. `w`/`h` are measured, so scale shows up in them; positions resolve about 0.3 px, and while nothing in the box changes they hold exactly. Add `opacity` to `props` for a fade: how much of its contrast at the anchor frame the subject shows (1 at the anchor), so a fade that goes on after the movement stops is measured too. It is fitted on the subject's own pixels, ignoring those that fit badly, so it holds near 1 while the subject slides and while a translucent band passes over part of it; `opacityNoise` is each sample's standard error (a jump in it means the reading is unsure, e.g. something covers most of the subject). Add `change` for the fraction of the box that visibly changed since the previous frame, with `change.starts` and `change.settles` (below). An easing fit carries `start`/`end` (`rest`, `range`, `appeared`, `disappeared`): an unseen end is estimated. When no curve is honest, `easingSkipped` says why per track: `no-motion` (under 2 px, or 0.02 in 0..1 units), `too-few-samples`, `partial` (the motion's end was not seen, so a fit would be invented) or `lost`.
   - `pass` is false only for errors and failed assertions; read `counts` (or `label`, e.g. "Pass with 2 warnings, 0 errors, 0 info; …") for warnings too. On the CLI a check that does not pass exits 1, after printing its result.
   - With only `assert`, no lint rules run, so the verdict is the assertions'; add `rules` to run some too.
5. Change the source (edit the animation, re-export the video).
6. **compare** before and after at the same moments (`view=side` or `view=diff`), and rerun the same `check --assert` to prove the change. Sources at different frame rates are matched by time, each side labelled with its own address; prefix an address with B's handle (`clip2@20s`) to read it on B's clock. When B starts later than A, `open B --offset N` (B runs N frames late) makes compare pair A's `0f` with B's `#N`; see [video](references/video.md#aligning-two-sources). `summary.changed` counts pairs where more than 0.1% of pixels changed beyond encoding noise, so a small UI change counts; `warnings` says when clocks, sizes or shapes differ.

## When does it start, and when does it settle?

Whole-frame motion (scan's `motion`, and `motion.energy` per frame in `format=detailed`) mixes every moving thing on the page, and a small element barely moves it. To time one element, measure its box:

1. Find where the element ends up: `frames --at -1f --view grid`, and read its box at rest.
2. `track` with that `box` and `props=["change"]`. The box is a fixed place on screen, so an element that fades or slides into it is measured where it lands; nothing is tracked. Both times use one stated rule, `change.within` (default 1 px or 2% opacity; set `withinPx`/`withinOpacity`): `change.starts` is the first frame that differs from the range's first frame by moving 1 px or more or fading 2% or more; `change.settles` is the first frame, never before `starts`, from which no frame differs that much from the range's last frame (null if it is still changing at the end: widen the range). `change.state` is `still` when nothing differs from the first frame. The fade is measured over all of the box's pixels together, so a 2% fade of high-contrast text counts even though each pixel moves less than the noise; it is a share of the box's whole change in the range, so measure over a range that covers the whole animation. A pixel counts only above the clip's noise (`change.floor`, at least 5 luma steps); a dim or brighten of the whole page around the box (a scrim) is taken out (`change.discounted`). `changing` lists the runs of frames that changed from the frame before by half a pixel or more, so a pulse or a second move shows up; a slow fade can have none.
3. If it slides in from off-screen, the box at rest sees it only once it enters that box: box the path too (from the frame edge it comes from) for when it first appears on screen.
4. For position and fade separately, `track` the same box backwards from the last frame (`range=-1f..0f`, `props=["x","y","opacity"]`): the position settles where `x`/`y` stop, the fade where `opacity` reaches 1. An element visible at the first frame can be tracked forwards instead.
5. Confirm on `frames --view diff` around the answer. The diff shows frame-to-frame change, so a settle by the 1 px / 2% rule can come before the last frame whose diff shows anything; and a diff `against` `-1f` counts any pixel over the noise floor, so it can settle a frame or two after `change.settles`.

## Costs and limits

- Sheets are sized for the model reading them: `target=high-res` (default, ≤2576 px, ≤4784 visual tokens) or `target=standard` (≤1568 px, ≤1568 tokens) for older tiers.
- Every image stays under 3.75 MB (5 MB as base64): an over-budget sheet is re-encoded with a palette, then scaled down. A custom `target` can set `maxBytes`; `format=detailed` reports each sheet's `bytes`.
- A call returns at most 4 sheets; continue with the `next` cursor. Labels number sheets across cursors: `Sheet 5 of 8`.
- Requests above 100 frames are refused; narrow the range or add a step (`0f..-1f:10f`), or use scan's `sample=motion`. A diff's numbers alone (`numbersOnly`) go to 1000 frames.
- On the CLI, stdout is only JSON. `open`, `probe`, `scan`, `track`, `record` and `schema` print one JSON value. `frames`, `compare` and `check` print JSON Lines: one sheet or finding per line, then a summary line; `kymo schema check` describes both under `lines`. Errors go to stderr. Exit codes: 0 done, 1 a check that did not pass, 2 bad input, 3 source not found, 4 adapter unavailable, 5 timeout, 6 backend failure.
- Results include file paths (CLI) or `kymo://` resource links (MCP). In long sessions, pass `images=links` to get links without image data, and reopen a file instead of asking for the same frames again.

## Errors

Errors carry a `tag`, a `message` and a `hint` with a valid example. Fix the input as the hint says; do not retry the same call. `AddressOutOfRange` tells you the duration and last frame.

## References

- [Video and image sequences](references/video.md)
- [Synthetic sources for testing](references/synthetic.md)
