import { assert, describe, it } from "@effect/vitest"
import { extractAnswer, score } from "../src/Score.ts"
import type { Answer, Clock } from "../src/Task.ts"

const at30: Clock = { rate: { num: 30, den: 1 }, frames: 300 }
const at60: Clock = { rate: { num: 60, den: 1 }, frames: 600 }
const frame = (index: number, tolerance = 0): Answer => ({ _tag: "frame", index, tolerance })

describe("extractAnswer", () => {
  it("takes the last ANSWER line and strips formatting", () => {
    assert.strictEqual(extractAnswer("ANSWER: #3\nthinking again\n**ANSWER:** `08s10f`."), "08s10f")
    assert.strictEqual(extractAnswer("- answer: ease-in"), "ease-in")
    assert.isUndefined(extractAnswer("The answer is #4"))
  })
})

describe("score: frame answers", () => {
  it("reads timecodes, indices and seconds on the task's clock", () => {
    assert.deepInclude(score(frame(250), at30, "ANSWER: 08s10f"), { pass: true, frameError: 0 })
    assert.deepInclude(score(frame(250), at30, "ANSWER: #250"), { pass: true, frameError: 0 })
    assert.deepInclude(score(frame(250), at30, "ANSWER: 8.33s"), { pass: true, frameError: 0 })
    // The same timecode is a different frame at 60 fps.
    assert.deepInclude(score(frame(250), at60, "ANSWER: 08s10f"), { pass: false, frameError: 240 })
  })

  it("passes within tolerance and fails just outside it", () => {
    assert.deepInclude(score(frame(20, 1), at30, "ANSWER: #21"), { pass: true, frameError: 1 })
    assert.deepInclude(score(frame(20, 1), at30, "ANSWER: #22"), { pass: false, frameError: 2 })
  })

  it("rejects what is not one in-range frame, with the reason", () => {
    const marker = score(frame(20), at30, "ANSWER: @impact1")
    assert.isFalse(marker.pass)
    assert.include(marker.problem, "no marker")
    assert.include(score(frame(20), at30, "ANSWER: #10..#20").problem, "range")
    assert.include(score(frame(20), at30, "ANSWER: #900").problem, "past the end")
    assert.include(score(frame(20), at30, "ANSWER: 20").problem, "unit")
    assert.deepInclude(score(frame(20), at30, "I think it is 20."), {
      given: null,
      problem: "no ANSWER: line"
    })
  })
})

describe("score: frame lists", () => {
  const dups: Answer = { _tag: "frames", indices: [45, 20, 46], tolerance: 0 }
  it("matches as a set, in any order and form, including ranges", () => {
    assert.isTrue(score(dups, at30, "ANSWER: #46, 20f, #45").pass)
    assert.isTrue(score(dups, at30, "ANSWER: #20, #45..#46").pass)
  })
  it("fails a wrong count or a wrong frame, with the mean error when counts agree", () => {
    assert.include(score(dups, at30, "ANSWER: #20, #45").problem, "listed 2 frames")
    assert.deepInclude(score(dups, at30, "ANSWER: #20, #45, #49"), { pass: false, frameError: 1 })
  })
})

describe("score: labels and counts", () => {
  it("matches labels exactly after case and separator normalisation", () => {
    const label: Answer = { _tag: "label", value: "ease-in-out" }
    assert.isTrue(score(label, at30, "ANSWER: Ease In Out").pass)
    assert.isFalse(score(label, at30, "ANSWER: ease-in").pass)
  })
  it("matches counts exactly and only whole numbers", () => {
    const count: Answer = { _tag: "count", value: 4 }
    assert.isTrue(score(count, at30, "ANSWER: 4").pass)
    assert.isFalse(score(count, at30, "ANSWER: 5").pass)
    assert.include(score(count, at30, "ANSWER: four").problem, "whole number")
  })
})
