# kymo eval harness

Every design choice in kymo is an A/B on the same tasks. This package holds the tasks, the agent loop that runs a model against the `kymo` MCP server, the scorer, and the experiment runner.

## Running it

```sh
bun run eval:smoke                                   # oracle, one task per question type, all splits
bun run eval -- run --model oracle --split dev       # oracle baseline on dev
bun run eval -- run --model claude-opus-5-5 --split dev --experiment target --limit 10
bun run eval -- experiments                          # list experiments and variants
bun run eval -- tasks                                # regenerate tasks/synthetic.json and tasks/ui.json
bun run eval -- ui-capture                           # capture the UI scenes in Chromium (see below)
bun run eval -- run --model oracle --set ui --split all
```

`run` options: `--set synthetic|ui|all` (default `synthetic`), `--model` (`oracle`, any `claude-*` id; `gpt-*` and `gemini-*` fail with a "not configured" error until their adapters exist), `--experiment`, `--split dev|heldout|all`, `--family`, `--per-family N`, `--limit N`, `--max-calls N` (default 20), `--concurrency N`, `--server "<command>"` (default `node apps/cli/bin/kymo.js mcp`), `--server-log`, `--clips`, `--effort` (default `high`), `--max-tokens`.

Claude runs need `ANTHROPIC_API_KEY`. Effort is pinned explicitly, because defaults differ between models. Refusal fallbacks are deliberately left off: a run served by a different model would measure the wrong thing, so a refusal is recorded as `stop: refused`.

Each run writes `eval/reports/runs/<timestamp>-<experiment>-<model>/`:

- `runs.jsonl`: one line per finished task, written as it finishes
- `results.json`: variants, summary rows, and every run with its replies, scores and tool-call log
- `summary.md`: a table per split (dev, then held out) with accuracy, mean frame error, images, visual tokens, total tokens, calls, tool errors, retries and time, plus accuracy by question type and a failure list

## Tasks

`tasks/synthetic.json` holds 42 tasks generated from the synthetic adapter (`src/Synthetic.ts`). Each case is a scene spec and a question type. The answer is read back from the opened source's `truth` markers and tracks; none is typed by hand. A test fails if the checked-in file differs from what generation produces now.

| Question                              | Scene       | Answer | Tolerance                     |
| ------------------------------------- | ----------- | ------ | ----------------------------- |
| When does the ball hit the wall       | `bounce`    | frame  | 1 frame                       |
| How many bounces                      | `bounce`    | count  | exact                         |
| Which easing                          | `ease`      | label  | exact                         |
| When is the flicker                   | `flicker`   | frame  | 0                             |
| When does the box leave the safe area | `safe-area` | frame  | 1 frame                       |
| Where is the cut                      | `cut`       | frame  | 0 (fade length for dissolves) |
| Which frames are duplicated           | `dropped`   | frames | 0                             |

Splits come from a hash of the task id (about 70% dev), so a task never moves between splits when others are added. Tune on dev only.

A synthetic spec names its own answer (`flicker?at=45`) and opens with truth markers. The model never sees it: the runner renders each spec once to PNGs under `eval/.cache/frames/<hash>/` and passes that directory, so the model gets pixels and nothing else.

Answers are the last `ANSWER:` line of the reply. Frame answers are parsed with core's `Address` grammar and resolved against the task's clock, so `08s10f`, `#250` and `8.33s` all work. Marker addresses don't score, because the scoring context has no markers.

### Real clips

`tasks/clips.json` lists real clips (`ClipManifest` in `src/TaskSet.ts`). Each entry has an `id`, a `category` (`ui-animation`, `promo`, `screen-recording`, `dashcam`, `telemetry+video`), a `file` path relative to the manifest, an `origin` (`url` and `license`), a `prompt`, an `answer` and optional `followUps`. The list is empty for now: clips are fetched separately and never committed. `--clips` loads every entry whose file exists, opens it once to read its clock, and lists the missing ones.

Multi-step tasks ("make this modal snappier, then prove it") use `followUps`. Each follow-up is asked in the same conversation after the previous answer, and the task passes only if every step does.

## UI animations

The synthetic set is saturated: the oracle and Opus both score 42/42, so it no longer separates designs. `tasks/ui.json` holds 87 tasks on footage of real web pages, captured in Chromium with exact ground truth from the browser. They are hard in the ways real UI footage is: small elements, fades, entries from off-screen, overlapping motion, distractors that never stop moving (spinners, a pulsing button, a dimming scrim), and H.264 at crf 23, 35 and 38.

### How a task is made

`eval/ui/scenes/` holds seven pages (`modal`, `spring`, `toast`, `janky`, `transition`, `safearea`, `compare`), each parameterised by its query string, and a small runtime (`scene.js`). `src/ui/Cases.ts` lists 54 captures and the questions asked about each; several questions share a capture. `bun run eval -- ui-capture` drives each page with Playwright at 1280x720: for frame `i` it pauses every Web Animation and seeks it to `i / fps` (or the scene sets styles directly, for the analytic spring and the stepped jank), waits two animation frames, records every tracked element's `getBoundingClientRect` and on-screen opacity, and takes a screenshot. The frames are encoded with x264 to `eval/.cache/ui/<key>/clip.mp4`. The key is a hash of the scene's files, its parameters and the encoder settings. Footage is never committed. It needs Chromium (`bunx playwright install chromium`) and ffmpeg, takes about three minutes from a clean cache, and produces the same truth byte for byte each time.

Answers are measured from the recorded truth (`src/ui/Measure.ts`), never typed in. A change is visible when an edge of the on-screen part of the element moves by 1 px (weighted by opacity), or when its opacity changes by 0.02. Frame tolerances come from the truth too: halve and double that threshold, and the tolerance covers where the answer moves to, so a long spring tail gets a wider window than a hard switch. Generation refuses a case whose answer is too close to call, such as a spring reversal 0.6 to 1.6 px from rest, or two variants that settle within tolerance of each other.

| Question                                             | Family             | Answer | Tolerance      | Tasks |
| ---------------------------------------------------- | ------------------ | ------ | -------------- | ----: |
| When does the element first visibly change           | `ui-start`         | frame  | from truth, ≥1 |    14 |
| When has it finished animating                       | `ui-settle`        | frame  | from truth, ≥2 |    14 |
| Which easing (CSS preset, or a spring)               | `ui-easing`        | label  | exact          |    10 |
| How many times does the spring reverse before rest   | `ui-overshoot`     | count  | exact          |     7 |
| Which frames repeat the previous position            | `ui-repeat`        | frames | 0              |     8 |
| Which frames land after a dropped frame              | `ui-skip`          | frames | 0              |     8 |
| When does the new page first show                    | `ui-screen-change` | frame  | from truth, ≥1 |     6 |
| When is the one-frame white flash                    | `ui-flash`         | frame  | 0              |     5 |
| When does the badge leave the safe area              | `ui-safe-area`     | frame  | 1              |     5 |
| When does the progress bar first go backwards        | `ui-reverse`       | frame  | 1              |     5 |
| How many frames sooner does the after variant settle | `ui-compare`       | delta  | from truth, ≥2 |     5 |

50 tasks are dev and 37 held out, by the same id hash as the synthetic set. The question tells the solver what an agent would know: which element, and its box at 0f when it is on screen there, or its box at rest when it fades or slides in from nothing (`Subject.seen`). `ui-compare` answers are a signed number of frames (`delta`): positive when the right-hand variant settles sooner.

Run them with `--set ui` (or `--set all`); `export` and `score` take `--set` too. Tasks whose footage is not cached are skipped and listed, with a hint to run `ui-capture`.

### Why the truth is checked in

CI has no browser, but the task file must not drift from what generation produces. So `ui-capture` also writes `eval/ui/truth.json`: every capture's per-frame boxes and opacities, rounded to a thousandth, with constant tracks folded to one number (about 50 KB). `test/ui.test.ts` regenerates the tasks from that file and fails if `tasks/ui.json` differs, and fails if the truth's capture keys differ from the keys the case list and scene files hash to now. Editing a scene, adding a case or changing capture settings without recapturing fails CI with a hint to run `ui-capture`. Changing only how answers are measured needs `bun run eval -- tasks`, no browser. The same test runs the oracle's tracking strategies against the recorded truth as a perfect tracker, so an oracle miss on footage is the tools', not the strategy's.

### Oracle baseline

The oracle attempts every UI family with only kymo's structured results. It is expected to miss: the misses are what the next kymo changes should fix. On kymo with the round-2 fixes it scores 64/87 (34/50 dev, 30/37 held out), up from 45/87 before them. Almost every remaining miss is an element that fades or slides in from nothing: with no box to track at 0f, only whole-frame motion energy is left, and UI motion sits below kymo's stillness floor. `eval/reports/ui-oracle-baseline.md` has both runs per family, with the reason for each miss.

## The loop

`src/Loop.ts` gives the model the source and question, runs its tool calls against the server, and stops when it replies without calling a tool, or before the call that would go over `--max-calls`. Model and server failures end that task with a `stop` reason and do not abort the experiment.

Model backends implement `ModelBackend` (`src/Model.ts`):

- `models/Anthropic.ts`: the Messages API. MCP image content becomes `image` blocks inside `tool_result`, kept in server order, so each label comes before its image.
- `models/Oracle.ts`: a scripted agent that follows the skill loop. It probes, then checks, scans or tracks, and answers from `structuredContent` alone. It gets the question's givens, never the answer. When the oracle fails a task, the tools did not make that task solvable.
- `models/Unconfigured.ts`: slots for OpenAI and Gemini that fail before any task runs.

Metrics per task: images sent, visual tokens (⌈w/28⌉ × ⌈h/28⌉ per image, from `@kymo/layout`), input tokens (including cache reads and writes), output tokens, tool calls, tool errors, retries (calls to a tool whose previous call failed), and wall-clock time.

## Experiments

`src/Experiments.ts` defines each A/B in the spec's checklist. A variant is a server config plus pinned tool arguments. The config is the server's own `ServerConfig` (from `kymo`); the runner starts each server with `toEnv(config)`, and the server reads it back with `fromEnv`, so a switch the server does not honour cannot be written. A test fails if two arms of an experiment have the same config and the same pins. A pinned argument is removed from the schema the model sees and overwrites whatever the model passes. Pins are checked against the server's published `inputSchema` at startup, so a pin that names a parameter the server lacks fails before any task runs.

| Experiment       | Variants                        | Mechanism                                |
| ---------------- | ------------------------------- | ---------------------------------------- |
| `target`         | high-res, standard              | pin `target` on scan, frames and compare |
| `cells`          | 4, 9, 12                        | pin `budget` on `kymo_scan`              |
| `label-style`    | timecode+index, timecode, index | config `labelStyle`                      |
| `onion-vs-sheet` | sheet, onion                    | pin `view` on `kymo_frames`              |
| `sampling`       | even, motion                    | pin `sample` on `kymo_scan`              |
| `tool-examples`  | on, off                         | config `toolExamples`                    |
| `text-fallback`  | json, markdown                  | config `textFormat`                      |

Synthetic tasks are always shown to the model as rendered pixels, never as the spec (which names its own answer). UI tasks are shown as the cached mp4 under its opaque key. `tracks-vs-pixels` returns with the Phase 3 web adapter, where tracks come from the page rather than from synthetic ground truth.
