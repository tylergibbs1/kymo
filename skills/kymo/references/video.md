# Video and image sequences

## What opens

| Source                       | Example                     | Clock                                   |
| ---------------------------- | --------------------------- | --------------------------------------- |
| Video file (mp4, mov, ogg…)  | `clip.mp4`                  | The container's frame rate              |
| Directory of numbered frames | `frames/`, `frames/?fps=24` | 30 fps unless `?fps=` says otherwise    |
| Animated GIF or WebP         | `loader.gif`                | The file's own frame delays, or `?fps=` |

Rates can be exact: `?fps=29.97` and `?fps=30000/1001` are the same rate. Directories hold PNG or JPG frames, played in name order (`frame_001.png`, `frame_002.png`, …). Video files are anything ffmpeg reads with one of the usual extensions: mp4, mov, m4v, webm, mkv, ogg/ogv, avi, flv, wmv/asf, mpg/mpeg, ts/mts/m2ts, 3gp, mxf, y4m.

Video needs `ffmpeg` and `ffprobe` on `PATH`, or `KYMO_FFMPEG` and `KYMO_FFPROBE` set to the binaries. Without them, video calls fail with `AdapterUnavailable` and an install hint; image sequences and synthetic sources still work.

## Handles

The first call on a path gives it a handle (`clip1`, `clip2`, …), remembered in `.kymo/handles.json` under the current directory. Pass the handle afterwards instead of the path. `kymo open clip.mp4 --as hero` or `kymo probe clip.mp4 --as hero` picks the name yourself. A name that already belongs to another source is refused, so its markers are never lost by accident; pass `--replace` to rebind it on purpose (its markers are dropped). Naming the same source again changes nothing.

## Variable frame rate

Phone and screen recordings are often variable frame rate, and animated GIFs and WebPs with uneven frame delays are too. `probe` reports `vfr: true`, the average rate as `fps`, and the real length as `durationSeconds` and `duration` (`32.48s`). On these sources seconds are real time and frames are decoded frames:

| Write                  | Means on a VFR source                                           |
| ---------------------- | --------------------------------------------------------------- |
| `16s`, `8.33s`, `-2s`  | the frame on screen at that time (counted from the end for `-`) |
| `5f`, `-1f`, `#350`    | decoded frames: the sixth, the last, index 350                  |
| `@cut1+5f`, `@cut1+1s` | five decoded frames after the marker; the frame 1 s after it    |
| `2s..4s:2f`, `:0.5s`   | every second decoded frame; one frame per half second           |

Labels, file names and `address` fields show each frame's own start time (`16.04s #350`), the same number as its `t`, so what you read is what you can pass back. `t` is the frame's presentation time; for a GIF, the start of its delay.

## Workflow

```sh
kymo probe clip.mp4                                  # handle, fps, duration, size
kymo scan clip1 --budget 8                            # overview, cuts, busy windows
kymo frames clip1 --range 2s..4s:2f --view onion      # path and spacing of a move
kymo check clip1 --rules duplicate-frames black-frames
kymo frames clip1 --at 2s --view grid                 # find the box at the range's first frame
kymo check clip1 --range 2s..4s --box 120,80,64,64 --rules safe-area --assert "box.x <= 554 at 3s"
kymo compare before.mp4 after.mp4 --at 0f 1s -1f --view diff
```

Images go to a fresh `kymo-*` temp directory per run, one subdirectory per handle, named by address (`0f-08s10f.png`). Pass `--out dir` to keep them.

## Telling what you see from what you measure

Video has no numeric tracks of its own. `track --box x,y,w,h` follows a region by template matching from the first frame of the range, so the box must be where the subject is at that frame (with `--range 2s..4s`, look at `2s`). Use `--anchor 3s` to read the box at another frame of the range, or a backwards range (`--range 4s..2s`) to track from the end: box a fading or entering element where it is fully visible and follow it back to where it appears. Matching ignores brightness and contrast, follows the part still inside the frame when the subject runs off an edge (positions past the edge are reported), and measures scale, so `w` and `h` change when the subject grows. It drifts on objects that rotate. `lost` lists the frames where it lost the region and why: `edge` (mostly past the frame edge), `faded` (faded out or hidden) or `low-confidence`. Use `--fit-easing` for an easing estimate and check the residual before trusting it. A fit's `start` and `end` say whether each end was seen at rest or estimated (`appeared`, `disappeared`); `easingSkipped` explains a track with no fit (`no-motion`, `too-few-samples`, `partial`, `lost`).

`check --box` measures the same way and feeds the result to `safe-area` (`--safe-margin 0.05` action-safe by default, `0.1` title-safe) and to assertions on `box.x`, `box.y`, `box.w` and `box.h`.
