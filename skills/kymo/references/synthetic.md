# Synthetic sources

A synthetic source renders a known motion with ground truth: exact tracks and markers for every frame. Use them to learn the tools, to test a rule or assertion before pointing it at real footage, and in evals.

The spec is `synthetic:<scene>?key=value&…`. Every scene takes the clip parameters `fps` (default 30), `frames` (default 90) and `size` (default `640x360`). An unknown or repeated key is an error, not ignored.

Every scene has the tracks `box.x`, `box.y`, `box.w`, `box.h` (px) and `box.opacity` (0..1) for its moving shape, so `track` returns ground truth with `method: "source"`.

| Scene       | Shows                                              | Parameters (defaults)                                                                                                                   | Markers                      | Extra tracks    |
| ----------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------- |
| `ease`      | a square moving left to right                      | `easing` linear, ease, ease-in, ease-out, ease-in-out, `cubic-bezier(a,b,c,d)`, `spring(k,c)` (ease-in-out); `start` (10%); `end` (90%) | `motion_start`, `motion_end` | `ease.progress` |
| `bounce`    | a ball falling sideways into a wall, rebounding    | `impact` first hit (frames/3); `bounces` (3); `period` first rebound (80% of impact); `decay` 0..1 (0.6)                                | `impact1`…`impactN`          |                 |
| `flicker`   | a static box with a one-frame brightness flash     | `at` (frames/2); `gain` -255..255 (60)                                                                                                  | `flicker`                    | `flash.gain`    |
| `safe-area` | a box drifting right until it leaves the safe area | `margin` 5 or 10 percent (10); `exit` first frame outside (60%)                                                                         | `exit_safe`                  |                 |
| `cut`       | two shots joined at a known frame                  | `at` first frame of shot B (frames/2); `fade` cross-dissolve frames (0, a hard cut)                                                     | `cut`                        | `cut.mix`       |
| `dropped`   | smooth motion where listed frames repeat           | `dups` comma-separated indices ≥ 1 (25%, 50%, 75%)                                                                                      | `dup1`…`dupN`                | `dup`           |

## Examples

```sh
kymo track "synthetic:ease?easing=ease-out" --props box.x --fit-easing
kymo frames "synthetic:bounce?impact=20" --at @impact1-2f..@impact1+2f --view onion
kymo check "synthetic:flicker?at=40" --rules flicker
kymo check synthetic:safe-area --rules safe-area --safe-margin 0.1   # the scene's margin is 10%
kymo scan "synthetic:cut?at=45&fade=10" --sample cuts
kymo check "synthetic:dropped?dups=20,50" --rules duplicate-frames
```

Quote specs with `?` or `&` in a shell. A scene's markers can be used in any address (`@impact1+5f`, `@cut..-1f`), and `scan` adds its own (`@cut1`, `@peak1`) to the source.
