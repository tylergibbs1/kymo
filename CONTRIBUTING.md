# Contributing to kymo

Thanks for helping. kymo is small on purpose: one core, thin shells, and an eval that decides design questions. Keep changes in that spirit.

## Set up

You need Node 24, [Bun](https://bun.sh) and ffmpeg. Bun installs and runs the scripts; kymo itself runs on Node.

```sh
git clone https://github.com/tylergibbs1/kymo && cd kymo
bun install
bun run test
bun run eval:smoke      # scripted agent answers every task type through the MCP server
```

## Where things live

| Path                                | What it holds                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/core`                     | Frame addresses, Timeline, typed errors. The contract everything else uses.             |
| `packages/sources`                  | One adapter per input kind (video, synthetic, image sequence) and the handle workspace. |
| `packages/layout`, `packages/views` | Sheet sizing per model target, and the views that draw labelled PNGs.                   |
| `packages/analysis`                 | Motion energy, cuts, sampling, tracking, easing fit, lint rules, assertions.            |
| `packages/kymo`                     | The operations. Each has one input and one output Schema.                               |
| `apps/cli`, `apps/mcp`              | The `kymo` binary and the MCP server, generated from those Schemas.                     |
| `eval`                              | Tasks with ground truth, the agent loop, experiments and reports.                       |
| `docs/diagrams`                     | Mermaid sources for the README diagrams, rendered to SVG with Pele.                     |

## How we work

- **Bugs get a failing test first**, then the fix, then a change that stops the same kind of bug coming back (a type, a lint rule, a shared schema).
- **Test at module boundaries**: through `Source.readFrames`, an op, the CLI binary or a real MCP client. Avoid testing internals.
- **Design questions go to the eval.** If you think 9 cells beat 12, add or run an experiment in `eval/src/Experiments.ts` and post the report.
- **The CLI and tool contract only grows.** Flags, fields and env vars are added, never renamed or repurposed.
- **Diagrams are Mermaid files** in `docs/diagrams`. Edit the `.mmd`, then run `bun run docs:diagrams` to render the light and dark SVGs; CI fails if they are stale.
- Run `bun run typecheck`, `bun run lint`, `bun run format` and `bun run test` before opening a pull request. CI runs the same, plus the eval smoke run.

## Good first issues

Issues labelled [`good first issue`](https://github.com/tylergibbs1/kymo/labels/good%20first%20issue) are scoped so you can finish them without learning the whole codebase.

## Conduct

Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
