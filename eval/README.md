# kymo eval harness

Every design choice in kymo is an A/B on the same tasks. This package holds the tasks, the agent loop that runs a model against the `kymo` MCP server, the scorer, and the experiment runner.

## Running it

```sh
npm run eval:smoke                                   # oracle, one task per question type, all splits
npm run eval -- run --model oracle --split dev       # oracle baseline on dev
npm run eval -- run --model claude-opus-5-5 --split dev --experiment target --limit 10
npm run eval -- experiments                          # list experiments and variants
npm run eval -- tasks                                # regenerate tasks/synthetic.json from ground truth
```

`run` options: `--model` (`oracle`, any `claude-*` id; `gpt-*` and `gemini-*` fail with a "not configured" error until their adapters exist), `--experiment`, `--split dev|heldout|all`, `--family`, `--per-family N`, `--limit N`, `--max-calls N` (default 20), `--concurrency N`, `--server "<command>"` (default `npx tsx apps/cli/src/bin.ts mcp`), `--server-log`, `--clips`, `--effort` (default `high`), `--max-tokens`.

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

Synthetic tasks are always shown to the model as rendered pixels, never as the spec (which names its own answer). `tracks-vs-pixels` returns with the Phase 3 web adapter, where tracks come from the page rather than from synthetic ground truth.
