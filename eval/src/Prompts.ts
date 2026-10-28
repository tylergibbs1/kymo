/**
 * Question text, rendered from a task's givens and its answer kind. Kept apart from the generator so
 * prompt wording can be A/B tested without touching ground truth.
 */
import {
  type AnswerKind,
  type Box,
  type Givens,
  type Subject,
  type SyntheticGivens,
  type UiGivens,
  isUiGivens
} from "./Task.ts"

const box = (b: Box) => `x=${b.x}, y=${b.y}, w=${b.w}, h=${b.h}`

/** How to write the final line, per answer kind. The scorer accepts exactly these forms. */
export const answerFormat: { readonly [K in AnswerKind]: string } = {
  frame:
    "End your reply with one line `ANSWER: <frame address>`, for example `ANSWER: 01s05f` or `ANSWER: #35`.",
  frames:
    "End your reply with one line listing every such frame, `ANSWER: <address>, <address>, ...`, for example `ANSWER: #12, #40`.",
  label:
    "End your reply with one line `ANSWER: <label>`, where the label is one of linear, ease-in, ease-out, ease-in-out, spring.",
  count: "End your reply with one line `ANSWER: <whole number>`, for example `ANSWER: 4`.",
  delta:
    "End your reply with one line `ANSWER: <signed whole number of frames>`, for example `ANSWER: 6` or `ANSWER: -4`."
}

/** The question for a synthetic family. Clip tasks carry their own prompt text. */
const syntheticQuestion = (givens: SyntheticGivens): string => {
  switch (givens._tag) {
    case "impact":
      return `A ball is pulled sideways toward a wall on the right of the frame. At 0f it is inside the box ${box(givens.subject)} (pixels). At which frame does the ball first touch the wall?`
    case "bounces":
      return `A ball is pulled sideways toward a wall on the right of the frame and rebounds off it. At 0f it is inside the box ${box(givens.subject)} (pixels). How many times does the ball hit the wall, counting the first hit and the hit where it comes to rest?`
    case "easing":
      return `A square moves from left to right once. At 0f it is inside the box ${box(givens.subject)} (pixels). Which easing curve does its horizontal motion follow?`
    case "flicker":
      return "This clip is a still shot, except the whole picture flickers for a single frame. At which frame does the flicker happen?"
    case "safe-area":
      return `A box drifts to the right. At 0f it is inside ${box(givens.subject)} (pixels). The safe area is inset ${givens.marginPercent}% from each edge of the frame. What is the first frame where any part of the box is outside the safe area?`
    case "cut":
      return "This clip joins two different shots. At which frame does the second shot begin (for a cross-dissolve, the first frame where the second shot starts showing)?"
    case "dropped":
      return "A square moves smoothly across the frame, but some frames repeat the picture of the frame before them. Which frames are the repeats?"
  }
}

const UI = "This is a screen recording of a web page."

const pointAt = (element: string, s: Subject) =>
  s.seen === "first-frame"
    ? `At 0f the ${element} is inside the box ${box(s.box)} (pixels).`
    : `Once it has finished animating, the ${element} occupies the box ${box(s.box)} (pixels).`

/** The question for a UI family. */
const uiQuestion = (givens: UiGivens): string => {
  switch (givens._tag) {
    case "ui-start":
      return `${UI} A ${givens.element} animates in. ${pointAt(givens.element, givens.subject)} At which frame does the ${givens.element} first visibly change (move or fade)?`
    case "ui-settle":
      return `${UI} A ${givens.element} animates in. ${pointAt(givens.element, givens.subject)} At which frame has it finished animating, that is, the first frame from which it no longer visibly changes?`
    case "ui-easing":
      return `${UI} A ${givens.element} moves once. At 0f it is inside the box ${box(givens.subject)} (pixels). Which easing curve does its motion follow?`
    case "ui-overshoot":
      return `${UI} A ${givens.element} springs to a new position. At 0f it is inside the box ${box(givens.subject)} (pixels). How many times does it reverse direction before it comes to rest? Count only reversals at least 1 pixel away from where it finally rests; answer 0 if it never overshoots.`
    case "ui-repeat":
      return `${UI} A box moves across the page in steps. At 0f it is inside the box ${box(givens.subject)} (pixels). While it is moving, at some frames it fails to advance and repeats its position from the frame before. Which frames are those repeats?`
    case "ui-skip":
      return `${UI} A box moves across the page in steps. At 0f it is inside the box ${box(givens.subject)} (pixels). While it is moving, at some frames it jumps twice as far as usual because a frame was dropped. At which frames does it land after such a jump?`
    case "ui-screen-change":
      return `${UI} Partway through, the app navigates to a different page. At which frame does the new page first become visible?`
    case "ui-flash":
      return `${UI} At one frame the whole page flashes white. At which frame?`
    case "ui-safe-area":
      return `${UI} A badge moves across the page. At 0f it is inside the box ${box(givens.subject)} (pixels). The safe area is inset ${givens.marginPercent}% from each edge of the frame. What is the first frame where any part of the badge is outside the safe area?`
    case "ui-reverse":
      return `${UI} A progress bar fills from left to right; its knob is at ${box(givens.subject)} (pixels) at 0f. At one point the progress goes backwards for a moment. At which frame is the knob first further left than in the frame before?`
    case "ui-compare":
      return `${UI} The same sheet opens twice, side by side: before on the left (at 0f inside ${box(givens.left)}) and after on the right (at 0f inside ${box(givens.right)}). Each finishes animating at the first frame from which it no longer visibly changes. How many frames sooner does the right one finish than the left one? Answer a negative number if the right one finishes later.`
  }
}

export const question = (givens: Exclude<Givens, { _tag: "clip" }>): string =>
  isUiGivens(givens) ? uiQuestion(givens) : syntheticQuestion(givens)

export const render = (givens: Exclude<Givens, { _tag: "clip" }>, kind: AnswerKind): string =>
  `${question(givens)}\n\n${answerFormat[kind]}`

/** The system prompt: how to work and how to answer, then the kymo skill itself. */
export const systemPrompt = (skill: string): string =>
  [
    "You answer questions about motion in a clip using the kymo tools. Measure rather than guess: prefer numbers from check, scan and track over reading positions off images.",
    "Work until you are confident, then reply with your reasoning in a sentence or two and end with the ANSWER line exactly as the question asks. Do not write an ANSWER line before you are done.",
    "",
    skill.replace(/^---[\s\S]*?---\s*/, "")
  ].join("\n")
