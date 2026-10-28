# kymo

kymo lets an AI agent see and measure motion. It turns a video, an image sequence or a synthetic scene into a Timeline (frames and numeric tracks on one clock) and answers questions about it with labelled contact sheets and numbers: what happens and when, where things cut, flicker or drop frames, how an animation is eased, and whether a change fixed it.

Every frame has one address (`08s10f`, `#250`, `-1f`, `@impact1+5f`, `2s..4s:2f`). The same address appears in image labels, JSON and file names, so an agent can pass back exactly what it saw.

## Install

kymo needs Node 24 and, for video, `ffmpeg` and `ffprobe` on `PATH` (or `KYMO_FFMPEG` and `KYMO_FFPROBE`).

```sh
brew install ffmpeg        # or: apt install ffmpeg
npm install
```

Inside this repo, run the CLI with `npx kymo …` or `npm run --silent kymo -- …`.

## CLI

```sh
kymo probe clip.mp4                                   # handle, fps, duration, size, tracks, markers
kymo scan clip1 --budget 8                             # overview sheet, motion summary, cuts, next ranges
kymo frames clip1 --at 0f 08s10f -1f                   # frames you already know
kymo frames clip1 --range 2s..4s:2f --view onion       # path and spacing of a move
kymo track "synthetic:ease?easing=ease-out" --fit-easing
kymo check clip1 --rules flicker black-frames --assert "@impact1 within #15..#25"
kymo compare before.mp4 after.mp4 --at 0f 1s -1f --view diff
kymo schema frames                                     # input and output JSON Schemas
```

stdout carries one JSON value; `frames`, `compare` and `check` print JSON Lines (one per sheet or finding, then the summary). Images are written to a fresh `kymo-*` temp directory, or `--out dir`. Every command also takes its whole input as `--json '{…}'`.

Errors go to stderr as `{"tag", "message", "hint"}`, and the exit code says what kind: 2 for bad input, 3 for a missing source, 4 for an unavailable capability (such as no ffmpeg), 5 for a timeout, 6 for a backend failure.

## MCP

```json
{
  "mcpServers": {
    "kymo": { "command": "npx", "args": ["kymo", "mcp"] }
  }
}
```

The server offers `kymo_probe`, `kymo_scan`, `kymo_frames`, `kymo_compare`, `kymo_track`, `kymo_check` and `kymo_record`. Each result puts a sheet's label right before its image, followed by a `kymo://` resource link. `kymo mcp --http :3917` serves Streamable HTTP on `/mcp` instead of stdio. Three environment variables switch server behaviour, all defined in `packages/kymo/src/ServerConfig.ts`: `KYMO_TOOL_EXAMPLES=on|off` (examples in tool descriptions), `KYMO_LABEL_STYLE=both|timecode|index` (frame labels on images and before them: `08s10f #250`, `08s10f` or `#250`; JSON addresses never change) and `KYMO_TEXT_FORMAT=json|markdown` (the text block next to `structuredContent`). Defaults are `on`, `both`, `json`; any other value stops the server at startup.

## Library

```ts
import { Effect } from "effect"
import { KymoLive, execute, scan } from "kymo"

const overview = await Effect.runPromise(
  execute(scan, { source: "clip.mp4", budget: 8 }).pipe(Effect.provide(KymoLive))
)
```

Each operation (`probe`, `scan`, `frames`, `compare`, `track`, `check`, `record`, `open`) carries its input and output Schemas. `execute` decodes the input, runs the operation and encodes the output as JSON; `op.run` takes and returns the decoded types. `kymoLayer({ out, root })` picks the image directory and the directory that holds `.kymo/handles.json`.

## Agent skill

[skills/kymo/SKILL.md](skills/kymo/SKILL.md) teaches an agent the loop: probe, scan, frames, track or check, change, compare.
