# UI set after round 3: Opus 5.5 subagents with the kymo CLI

Overall 86/87 · dev 50/50 · heldout 36/37 · mean frame error 0.13

| ui-compare | ui-easing | ui-flash | ui-overshoot | ui-repeat | ui-reverse | ui-safe-area | ui-screen-change | ui-settle | ui-skip | ui-start |
| ---------: | --------: | -------: | -----------: | --------: | ---------: | -----------: | ---------------: | --------: | ------: | -------: |
|        5/5 |      9/10 |      5/5 |          7/7 |       8/8 |        5/5 |          5/5 |              6/6 |     14/14 |     8/8 |    14/14 |

## Misses

| Question | Task               | Given  | Problem      |
| -------- | ------------------ | ------ | ------------ |
| q33      | ui-easing-css-ease | spring | wrong answer |

## Notes

The same setup as `ui-subagents-opus.md` (three Opus 5.5 subagents, 29 questions each, kymo CLI and skill only), rerun after round 3 with the start and settle questions stating the 1 px / 2% rule. The first run scored 83/87 with a mean frame error of 0.97; this one scores 86/87 with 0.13. The scripted oracle scores 86/87 on the same tasks.

The one miss, `ui-easing-css-ease`, was the task's fault: the page animates with CSS `ease`, which was not an allowed label, and the key said `ease-out`. The agent identified `ease` and had to guess. `ease` is now a label, every easing case takes its expected label from the easing its page uses, and the generator checks it against the nearest CSS curve.

What the agents still worked around in kymo:

- `track --props change` reports `settles` by a sub-pixel rule, later than "within 1 px and 2% of the end"; agents applied the threshold by hand from the position track, not always consistently. On one box `settles` came before `starts` with no changing runs.
- `opacity` is noisy on moving or high-contrast content (0.8–1.05 frame to frame), and a translucent overlay passing over the subject reads as the subject fading.
- No way to diff a frame against a fixed reference (frame N against the last frame) in one source; `compare` only pairs two sources.
- `track --props ... opacity --fit-easing` fails with `Cannot read properties of undefined (reading 'solved')`.
- `check --rules non-monotonic` with `--box` asks for `tracks=box.x`, but no such flag or field exists.
- `scan` still read a one-frame flash as a fade cut on two clips.
- `frames --view diff` over a whole 120-frame clip is refused by the frame cap, though a diff could return numbers only.
