/**
 * The UI case list: browser captures, and the questions asked about each. Parameters choose what the
 * page does; no answer is written here. Answers are read from what the browser recorded (Tasks.ts).
 */
import type { EasingLabel, UiElement } from "../Task.ts"
import type { CaptureSpec, SceneName } from "./Truth.ts"

/** What is asked, and which recorded element (`dialog`, `next`, …) the answer is read from. */
export type Question =
  | { readonly family: "ui-start" | "ui-settle"; readonly target: string; readonly element: UiElement }
  | {
      readonly family: "ui-easing"
      readonly target: string
      readonly element: UiElement
      /** The label these parameters are meant to produce; generation fails if the truth disagrees. */
      readonly expect: EasingLabel
    }
  | { readonly family: "ui-overshoot"; readonly target: string; readonly element: UiElement }
  | {
      readonly family: "ui-repeat" | "ui-skip" | "ui-reverse" | "ui-screen-change" | "ui-flash"
      readonly target: string
    }
  | { readonly family: "ui-safe-area"; readonly target: string; readonly marginPercent: 5 | 10 }
  | { readonly family: "ui-compare"; readonly left: string; readonly right: string }

export type UiCase = Question & { readonly id: string; readonly capture: CaptureSpec }

const DEFAULT_CRF = 23

const cap = (scene: SceneName, params: Readonly<Record<string, string | number>>, crf = DEFAULT_CRF) => ({
  scene,
  params,
  crf
})

/** Ask when an element starts and when it settles, from one capture. */
const timing = (id: string, capture: CaptureSpec, target: string, element: UiElement): Array<UiCase> => [
  { id: `${id}-start`, capture, family: "ui-start", target, element },
  { id: `${id}-settle`, capture, family: "ui-settle", target, element }
]

const modal = (params: Readonly<Record<string, string | number>>, crf?: number) => cap("modal", params, crf)

const easing = (
  id: string,
  capture: CaptureSpec,
  target: string,
  element: UiElement,
  expect: EasingLabel
): UiCase => ({ id, capture, family: "ui-easing", target, element, expect })

const overshoot = (id: string, capture: CaptureSpec): UiCase => ({
  id,
  capture,
  family: "ui-overshoot",
  target: "card",
  element: "card"
})

const janky = (
  id: string,
  params: Readonly<Record<string, string | number>>,
  crf?: number
): Array<UiCase> => {
  const capture = cap("janky", params, crf)
  return [
    { id: `${id}-repeat`, capture, family: "ui-repeat", target: "box" },
    { id: `${id}-skip`, capture, family: "ui-skip", target: "box" }
  ]
}

const transition = (
  id: string,
  params: Readonly<Record<string, string | number>>,
  crf?: number
): Array<UiCase> => {
  const capture = cap("transition", params, crf)
  return [
    { id: `${id}-change`, capture, family: "ui-screen-change", target: "next" },
    ...(Number(params["flash"] ?? -1) >= 0
      ? [{ id: `${id}-flash`, capture, family: "ui-flash" as const, target: "flash" }]
      : [])
  ]
}

const safearea = (
  id: string,
  marginPercent: 5 | 10,
  params: Readonly<Record<string, string | number>>,
  crf?: number
): Array<UiCase> => {
  const capture = cap("safearea", params, crf)
  return [
    { id: `${id}-safe`, capture, family: "ui-safe-area", target: "badge", marginPercent },
    { id: `${id}-reverse`, capture, family: "ui-reverse", target: "knob" }
  ]
}

const compare = (id: string, params: Readonly<Record<string, string | number>>, crf?: number): UiCase => ({
  id,
  capture: cap("compare", params, crf),
  family: "ui-compare",
  left: "left",
  right: "right"
})

const SNAPPY = "cubic-bezier(0.2,0.9,0.3,1)"

export const UI_CASES: ReadonlyArray<UiCase> = [
  // Entrances: a fade plus a rise, so the element is not there at 0f and is pointed out at rest.
  ...timing("ui-modal-300-out", modal({ dur: 300, ease: "ease-out", delay: 200 }), "dialog", "dialog"),
  ...timing("ui-modal-200-snappy", modal({ dur: 200, ease: SNAPPY, delay: 150 }), "dialog", "dialog"),
  ...timing(
    "ui-modal-scrim",
    modal({ dur: 450, ease: "ease-in-out", delay: 300, dist: 40, scrim: 600 }),
    "dialog",
    "dialog"
  ),
  ...timing(
    "ui-tooltip",
    modal({ w: 180, h: 36, x: 900, y: 140, dur: 150, delay: 400, dist: 8, color: "#1f2a44" }),
    "dialog",
    "tooltip"
  ),
  ...timing(
    "ui-popover-fade",
    modal({ w: 260, h: 160, x: 820, y: 120, dist: 0, dur: 250, ease: "linear", delay: 100 }),
    "dialog",
    "popover"
  ),
  ...timing(
    "ui-modal-slide",
    modal({ dist: 160, fade: 0, dur: 500, ease: "ease-in-out", delay: 250 }),
    "dialog",
    "dialog"
  ),
  ...timing(
    "ui-modal-spinner",
    modal({ dur: 350, ease: "ease-out", delay: 350, spinner: 1 }),
    "dialog",
    "dialog"
  ),
  ...timing(
    "ui-popover-crf38",
    modal({ w: 300, h: 180, x: 160, y: 380, dist: 24, dur: 220, delay: 500 }, 38),
    "dialog",
    "popover"
  ),
  ...timing(
    "ui-tooltip-spinner-crf35",
    modal({ w: 150, h: 32, x: 120, y: 200, dist: 6, dur: 180, delay: 250, spinner: 1, color: "#7a3cc3" }, 35),
    "dialog",
    "tooltip"
  ),
  ...timing("ui-toast-right", cap("toast", { dur: 400, ease: "ease-out", delay: 200 }), "toast", "toast"),
  ...timing(
    "ui-snackbar-pulse",
    cap("toast", { from: "bottom", w: 420, dur: 300, ease: "ease-in-out", delay: 500, pulse: 300 }),
    "toast",
    "snackbar"
  ),
  ...timing(
    "ui-toast-small-pulse",
    cap("toast", { w: 240, h: 48, dur: 250, ease: SNAPPY, delay: 100, pulse: 450, color: "#2b59c3" }),
    "toast",
    "toast"
  ),
  ...timing("ui-spring-card", cap("spring", { k: 170, c: 12 }), "card", "card"),
  ...timing(
    "ui-spring-cross",
    cap("spring", { k: 250, c: 18, x0: 900, dist: -600, cross: 1 }),
    "card",
    "card"
  ),

  // Easing: the element is visible at 0f and only moves.
  easing(
    "ui-easing-linear",
    modal({ fade: 0, dist: 200, ease: "linear", dur: 600, delay: 100 }),
    "dialog",
    "dialog",
    "linear"
  ),
  easing(
    "ui-easing-in",
    modal({ fade: 0, dist: 200, ease: "ease-in", dur: 500, delay: 100 }),
    "dialog",
    "dialog",
    "ease-in"
  ),
  easing(
    "ui-easing-out",
    modal({ fade: 0, dist: 200, ease: "ease-out", dur: 500, delay: 100 }),
    "dialog",
    "dialog",
    "ease-out"
  ),
  easing(
    "ui-easing-in-out",
    modal({ fade: 0, dist: 200, ease: "ease-in-out", dur: 600, delay: 100 }),
    "dialog",
    "dialog",
    "ease-in-out"
  ),
  easing(
    "ui-easing-css-ease",
    modal({ fade: 0, dist: 180, ease: "ease", dur: 500, delay: 150 }),
    "dialog",
    "dialog",
    "ease-out"
  ),
  easing(
    "ui-easing-tooltip-in",
    modal({ w: 180, h: 36, x: 900, y: 140, fade: 0, dist: 60, ease: "ease-in", dur: 400, delay: 100 }),
    "dialog",
    "tooltip",
    "ease-in"
  ),
  easing(
    "ui-easing-in-out-crf38",
    modal({ w: 320, h: 200, fade: 0, dist: 150, ease: "ease-in-out", dur: 500, delay: 100 }, 38),
    "dialog",
    "dialog",
    "ease-in-out"
  ),
  easing("ui-easing-spring", cap("spring", { k: 170, c: 12 }), "card", "card", "spring"),
  easing("ui-easing-spring-stiff", cap("spring", { k: 300, c: 20, dist: 500 }), "card", "card", "spring"),
  easing(
    "ui-easing-linear-small",
    modal({ w: 120, h: 32, x: 200, y: 150, fade: 0, dist: 50, ease: "linear", dur: 500, delay: 100 }),
    "dialog",
    "tooltip",
    "linear"
  ),

  // Springs: how many times it swings back before resting.
  overshoot("ui-overshoot-170-12", cap("spring", { k: 170, c: 12, dist: 350 })),
  overshoot("ui-overshoot-300-20", cap("spring", { k: 300, c: 20, dist: 300 })),
  overshoot("ui-overshoot-overdamped", cap("spring", { k: 120, c: 30 })),
  overshoot("ui-overshoot-400-14", cap("spring", { k: 400, c: 14, dist: 600 })),
  overshoot("ui-overshoot-small", cap("spring", { k: 200, c: 14, w: 80, h: 50, dist: 120, y: 420 })),
  overshoot("ui-overshoot-left-cross", cap("spring", { k: 250, c: 18, x0: 900, dist: -400, cross: 1 })),
  overshoot("ui-overshoot-crf38", cap("spring", { k: 170, c: 12, dist: 300 }, 38)),

  // Jank: repeated frames (a late timer) and double steps (a dropped frame).
  ...janky("ui-jank-basic", { dups: "20", skips: "40" }),
  ...janky("ui-jank-pair", { dups: "12,30,31", skips: "50" }),
  ...janky("ui-jank-catchup", { dups: "25", skips: "26" }),
  ...janky("ui-jank-spinner", { dups: "15,45", skips: "60", spinner: 1 }),
  ...janky("ui-jank-small-crf35", { dups: "33", skips: "18,52", size: 24, step: 4, y: 480 }, 35),
  ...janky("ui-jank-many", { dups: "10,40,70", skips: "41,71", step: 6 }),
  ...janky("ui-jank-slow", { dups: "22", skips: "48", step: 3, size: 48, y: 200 }),
  ...janky("ui-jank-wide", { dups: "35,36", skips: "64", step: 12, size: 120, x0: 40, steps: 60 }, 35),

  // Page changes, with a one-frame white flash as a separate question.
  ...transition("ui-nav-dissolve", { at: 1000, len: 250, flash: 100 }),
  ...transition("ui-nav-instant", { at: 600, len: 0, flash: 30 }),
  ...transition("ui-nav-ease-in-spinner", { at: 800, len: 400, ease: "ease-in", flash: 95, spinner: 1 }),
  ...transition("ui-nav-slide-light", { at: 500, len: 300, ease: "ease-out", theme: "light", slide: 200 }),
  ...transition("ui-nav-short-crf35", { at: 1200, len: 150, flash: 60, spinner: 1 }, 35),
  ...transition("ui-nav-light-slow", { at: 300, len: 500, ease: "ease-in-out", theme: "light", flash: 110 }),

  // A badge drifting out of the safe area while a progress bar stalls backwards.
  ...safearea("ui-safe-right-5", 5, { bx: 200, speed: 16, rev: 50, revLen: 6, revRate: 15 }),
  ...safearea("ui-safe-left-10", 10, { bx: 900, speed: -12, rev: 30, revLen: 3, revRate: 6 }),
  ...safearea("ui-safe-small-diag", 5, {
    bw: 60,
    bh: 24,
    bx: 300,
    by: 300,
    speed: 10,
    vy: 4,
    rev: 70,
    revLen: 2,
    revRate: 4
  }),
  ...safearea("ui-safe-overlap-10", 10, { bx: 300, by: 440, speed: 10, rev: 40, revLen: 8, revRate: 10 }),
  ...safearea("ui-safe-fast-crf38", 5, { bx: 500, speed: 20, rev: 20, revLen: 4, revRate: 12 }, 38),

  // Before and after: how much sooner the right-hand variant settles.
  compare("ui-compare-snappier", { ldur: 400, lease: "ease-out", rdur: 250, rease: SNAPPY }),
  compare("ui-compare-ease-in", {
    ldur: 300,
    lease: "ease-out",
    ldelay: 0,
    rdur: 200,
    rease: "ease-in",
    rdelay: 0
  }),
  compare("ui-compare-slower", { ldur: 250, lease: "linear", rdur: 450, rease: "ease-out" }),
  compare("ui-compare-delayed", {
    ldur: 500,
    lease: "ease-in-out",
    ldelay: 100,
    rdur: 300,
    rease: "ease-out",
    rdelay: 250
  }),
  compare("ui-compare-crf35", { ldur: 350, lease: "ease", rdur: 200, rease: "ease-out" }, 35)
]
