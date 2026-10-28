# UI set: Opus 5.5 subagents with the kymo CLI

Overall 83/87 · dev 50/50 · heldout 33/37 · mean frame error 0.97

| ui-compare | ui-easing | ui-flash | ui-overshoot | ui-repeat | ui-reverse | ui-safe-area | ui-screen-change | ui-settle | ui-skip | ui-start |
| ---------: | --------: | -------: | -----------: | --------: | ---------: | -----------: | ---------------: | --------: | ------: | -------: |
|        4/5 |     10/10 |      5/5 |          7/7 |       8/8 |        5/5 |          5/5 |              6/6 |     11/14 |     8/8 |    14/14 |

## Misses

| Question | Task                       | Given | Problem      |
| -------- | -------------------------- | ----- | ------------ |
| q04      | ui-modal-200-snappy-settle | #21   | wrong answer |
| q26      | ui-spring-card-settle      | #107  | wrong answer |
| q28      | ui-spring-cross-settle     | #67   | wrong answer |
| q83      | ui-compare-snappier        | 9     | wrong answer |

## Notes

Three Opus 5.5 subagents, 29 questions each, answered with only the kymo CLI and the skill (exported with `eval export --set ui --split all`, scored with `eval score`). The scripted oracle scores 64/87 on the same tasks.

All four misses are settle questions where the agent answered later than the key. The key counts an element as finished once it stays within 1 px of where it ends (tolerance spans 0.5–2 px); the prompt says "no longer visibly changes", and the agents counted sub-pixel anti-aliasing creep that the diff view shows. The prompt and the key measure different things.

What the agents reported missing from kymo:

- Per-frame change inside a box. Agents read whole-frame energy from `scan --format detailed` (undocumented) or abused `check --assert "motion < 0 at Nf"` to see the value; other motion on the page mixes in.
- A number for the diff view: its heatmap is auto-scaled, so codec noise looks like change.
- Opacity: `track` ignores brightness, so a fade that continues after movement stops can't be measured.
- `check --rules dropped-frames` misses a double step right after a held frame.
- `scan` reports a one-frame white flash, and a dimming backdrop, as fade cuts.
