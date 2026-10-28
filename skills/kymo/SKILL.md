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

Labels show both forms: `08s10f #250`. Quote either back.

## The loop

1. **probe** the source: fps, duration, size, tracks, markers. Cheap, no images.
2. **scan** with a small budget (6–12) for an overview. Use `sample=motion` to spend frames where things change; cuts are always included. Read the motion-energy summary and the suggested next ranges. Scan saves what it finds as markers on the source (`@cut1`, `@peak1`), so later calls can address them.
3. **frames** at the interesting addresses. Pick the view for the question:
   - `sheet`: what happens at these moments
   - `onion`: path and spacing of a motion (easing, arcs)
   - `diff`: what changed between consecutive frames, and where
   - `follow`: one region up close over time
   - `grid`: rough on-screen position (orientation only; never read coordinates off pixels when a track exists)
4. **track** or **check** for numbers. Prefer measured numbers over estimates from pixels: `track` returns positions per frame and an easing fit; `check` runs lint rules (flicker, dropped/duplicate frames, black frames, safe area, non-monotonic curves) and assertions such as `box.x <= 600 at 1s` or `@impact1 within #40..#50`.
5. Change the source (edit the animation, re-export the video).
6. **compare** before and after at the same addresses (`view=side` or `view=diff`), and rerun the same `check --assert` to prove the change.

## Costs and limits

- Sheets are sized for the model reading them: `target=high-res` (default, ≤2576 px, ≤4784 visual tokens) or `target=standard` (≤1568 px, ≤1568 tokens) for older tiers.
- A call returns at most 4 sheets; continue with the `next` cursor.
- Requests above 100 frames are refused; narrow the range, add a step, or use `sample=motion`.
- Results include file paths (CLI) or `kymo://` resource links (MCP). In long sessions, pass `images=links` to get links without image data, and reopen a file instead of asking for the same frames again.

## Errors

Errors carry a `tag`, a `message` and a `hint` with a valid example. Fix the input as the hint says; do not retry the same call. `AddressOutOfRange` tells you the duration and last frame.

## References

- [Video and image sequences](references/video.md)
- [Synthetic sources for testing](references/synthetic.md)
