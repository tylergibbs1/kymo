# Video and image sequences

## What opens

| Source                       | Example                     | Clock                                   |
| ---------------------------- | --------------------------- | --------------------------------------- |
| Video file (mp4, mov, webm…) | `clip.mp4`                  | The container's frame rate              |
| Directory of numbered frames | `frames/`, `frames/?fps=24` | 30 fps unless `?fps=` says otherwise    |
| Animated GIF or WebP         | `loader.gif`                | The file's own frame delays, or `?fps=` |

Rates can be exact: `?fps=29.97` and `?fps=30000/1001` are the same rate. Directories hold PNG or JPG frames, played in name order (`frame_001.png`, `frame_002.png`, …).

Video needs `ffmpeg` and `ffprobe` on `PATH`, or `KYMO_FFMPEG` and `KYMO_FFPROBE` set to the binaries. Without them, video calls fail with `AdapterUnavailable` and an install hint; image sequences and synthetic sources still work.

## Handles

The first call on a path gives it a handle (`clip1`, `clip2`, …), remembered in `.kymo/handles.json` under the current directory. Pass the handle afterwards instead of the path. `kymo open clip.mp4 --as hero` picks the name yourself.

## Variable frame rate

Phone and screen recordings are often variable frame rate. `probe` reports `vfr: true`, the average rate as `fps` and the real duration. Addresses still name decoded frames in order, so on VFR footage `#index` is the exact form; timecodes are approximate.

## Workflow

```sh
kymo probe clip.mp4                                  # handle, fps, duration, size
kymo scan clip1 --budget 8                            # overview, cuts, busy windows
kymo frames clip1 --range 2s..4s:2f --view onion      # path and spacing of a move
kymo check clip1 --rules duplicate-frames black-frames
kymo compare before.mp4 after.mp4 --at 0f 1s -1f --view diff
```

Images go to a fresh `kymo-*` temp directory per run, one subdirectory per handle, named by address (`0f-08s10f.png`). Pass `--out dir` to keep them.

## Telling what you see from what you measure

Video has no numeric tracks of its own. `track --box x,y,w,h` follows a region by template matching from its first frame; it works for objects that keep their look while they move, and drifts on objects that fade, scale a lot or rotate. Use `--fit-easing` for an easing estimate and check the residual before trusting it.
