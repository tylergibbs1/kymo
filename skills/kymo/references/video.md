# Video and image sequences

## What opens

| Source                       | Example                     | Clock                                   |
| ---------------------------- | --------------------------- | --------------------------------------- |
| Video file (mp4, mov, ogg…)  | `clip.mp4`                  | The container's frame rate              |
| Directory of numbered frames | `frames/`, `frames/?fps=24` | 30 fps unless `?fps=` says otherwise    |
| Animated GIF or WebP         | `loader.gif`                | The file's own frame delays, or `?fps=` |

A directory has no timing of its own, so probe reports `"rateFrom": "assumed"`; pass the capture rate with `?fps=` before reading any time or duration. Rates can be exact: `?fps=29.97` and `?fps=30000/1001` are the same rate. Directories hold PNG or JPG frames, played in name order (`frame_001.png`, `frame_002.png`, …). Video files are anything ffmpeg reads with one of the usual extensions: mp4, mov, m4v, webm, mkv, ogg/ogv, avi, flv, wmv/asf, mpg/mpeg, ts/mts/m2ts, 3gp, mxf, y4m.

Video needs `ffmpeg` and `ffprobe` on `PATH`, or `KYMO_FFMPEG` and `KYMO_FFPROBE` set to the binaries. Without them, video calls fail with `AdapterUnavailable` and an install hint; image sequences and synthetic sources still work.

## Handles

The first call on a path gives it a handle (`clip1`, `clip2`, …), remembered in `.kymo/handles.json` under the current directory. Pass the handle afterwards instead of the path. `kymo open clip.mp4 --as hero` or `kymo probe clip.mp4 --as hero` picks the name yourself. A name that already belongs to another source is refused, so its markers are never lost by accident; pass `--replace` to rebind it on purpose (its markers are dropped). Naming the same source again changes nothing.

## Aligning two sources

When one source starts later than another (a re-record, telemetry, a second camera), tell kymo once and `compare` pairs the same moments:

```sh
kymo open before.mp4 --as before
kymo open after.mp4 --as after --offset 6     # after runs 6 frames late
kymo compare before after --view diff          # before@0f is paired with after's #6
```

`--offset N` says the source runs N frames late: its frame N shows what an unshifted source shows at `0f`. A source that runs early takes a negative offset; `--offset 0` clears it. It is counted in the source's own frames (at its average rate when the rate is variable), stored with the handle, and shown by `probe` and `open`. `compare` applies both sides' offsets: A's frame `i` is paired with B's frame `i − offsetA + offsetB`, so an address names the same moment on both, and `B@…` addresses map back the same way. Its output lists the `offsets` applied, and the sheet label names them (`clip1 vs clip2 (clip2 +6f)`). Without `at` or `range`, frames of A that the shift leaves without a B frame are listed in `warnings`; an address shifted past B's ends fails with the range both sources share.

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

Positions resolve about 0.3 px on clean footage. While nothing in the box changes beyond the noise, the position holds exactly, so a box at rest does not jitter; on heavily compressed footage (crf 35 and up) it can still wander by about 0.1 px. `--props opacity` adds how much of its contrast at the anchor frame the subject shows (1 at the anchor, 0 when gone), measured where it is or where it was last seen as it faded: use it for fades, which `x`/`y` cannot see.

`--props change` measures the box as a fixed place on screen instead: per frame, the fraction of its pixels that visibly changed since the previous frame (`box.change`, 0..1), plus `change.starts`, `change.settles`, the runs of frames that changed and the noise `floor` used. It reads the box at most at half the source resolution (and with its long edge at most 128 px), counts a pixel only when it changed by more than the clip's own noise (at least 5 luma steps) and, on an edge, by more than half a pixel of movement would make it change, and takes out a dim or brighten of the whole page around the box. It works on any range, and does not need the subject at the anchor frame.

```sh
kymo frames clip1 --at -1f --view grid                          # the element's box at rest
kymo track clip1 --box 916,80,340,64 --props change              # starts, settles, changing runs
kymo track clip1 --box 916,80,340,64 --range -1f..0f --props x y opacity --format detailed
kymo frames clip1 --range 30f..40f --view diff --box 916,80,340,64   # changedFraction per frame
```

`frames --view diff` draws each frame N as its change from N−1 on a fixed scale: black under the noise floor named in the sheet label, white a full-scale change. Its `diff` field has each frame's `changedFraction` and `changedMean`, over the whole frame or inside `--box`. Because N is compared with N−1, the frame where a motion ends is the last frame with change.

`check --box` measures the same way and feeds the result to `safe-area` (`--safe-margin 0.05` action-safe by default, `0.1` title-safe) and to assertions on `box.x`, `box.y`, `box.w`, `box.h`, `box.opacity` and `box.change` (e.g. `--assert "box.change == 0 after 40f"`).
