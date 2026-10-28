/**
 * Question text, rendered from a task's givens and its answer kind. Kept apart from the generator so
 * prompt wording can be A/B tested without touching ground truth.
 */
import type { AnswerKind, Box, Givens } from "./Task.ts"

const box = (b: Box) => `x=${b.x}, y=${b.y}, w=${b.w}, h=${b.h}`

/** How to write the final line, per answer kind. The scorer accepts exactly these forms. */
export const answerFormat: { readonly [K in AnswerKind]: string } = {
  frame:
    "End your reply with one line `ANSWER: <frame address>`, for example `ANSWER: 01s05f` or `ANSWER: #35`.",
  frames:
    "End your reply with one line listing every such frame, `ANSWER: <address>, <address>, ...`, for example `ANSWER: #12, #40`.",
  label:
    "End your reply with one line `ANSWER: <label>`, where the label is one of linear, ease-in, ease-out, ease-in-out, spring.",
  count: "End your reply with one line `ANSWER: <whole number>`, for example `ANSWER: 4`."
}

/** The question for a synthetic family. Clip tasks carry their own prompt text. */
export const question = (givens: Exclude<Givens, { _tag: "clip" }>): string => {
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
