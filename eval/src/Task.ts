/**
 * The task contract. Every task the harness runs, synthetic or real clip, decodes through `Task`, so
 * a malformed task file fails at load time with a path to the bad field, never mid-run.
 */
import { Rate } from "@kymo/core"
import { Schema } from "effect"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export const Split = Schema.Literals(["dev", "heldout"])
export type Split = typeof Split.Type

/** Easing families a task can ask the model to name. */
export const EasingLabel = Schema.Literals(["linear", "ease-in", "ease-out", "ease-in-out", "spring"])
export type EasingLabel = typeof EasingLabel.Type

/**
 * The correct answer. Frame answers carry their own tolerance (in frames), so a label or a count can
 * never be given a meaningless one.
 */
export const Answer = Schema.Union([
  Schema.TaggedStruct("frame", { index: NonNegativeInt, tolerance: NonNegativeInt }),
  Schema.TaggedStruct("frames", {
    indices: Schema.NonEmptyArray(NonNegativeInt),
    tolerance: NonNegativeInt
  }),
  Schema.TaggedStruct("label", { value: Schema.String.check(Schema.isNonEmpty()) }),
  Schema.TaggedStruct("count", { value: NonNegativeInt })
])
export type Answer = typeof Answer.Type
export type AnswerKind = Answer["_tag"]

/** A box in source pixels, as the tracker takes it. */
export const Box = Schema.Struct({ x: NonNegativeInt, y: NonNegativeInt, w: PositiveInt, h: PositiveInt })
export type Box = typeof Box.Type

/**
 * What the question tells the solver, beyond the source. Prompts are rendered from these, and the
 * scripted oracle reads the same fields, so the two can never disagree about what was given.
 * Givens never contain the answer.
 */
export const Givens = Schema.Union([
  Schema.TaggedStruct("impact", { subject: Box }),
  Schema.TaggedStruct("bounces", { subject: Box }),
  Schema.TaggedStruct("easing", { subject: Box }),
  Schema.TaggedStruct("flicker", {}),
  Schema.TaggedStruct("safe-area", { subject: Box, marginPercent: Schema.Literals([5, 10]) }),
  Schema.TaggedStruct("cut", {}),
  Schema.TaggedStruct("dropped", {}),
  /** A real clip: the prompt is free text written in the manifest. */
  Schema.TaggedStruct("clip", { category: Schema.String })
])
export type Givens = typeof Givens.Type
export type Family = Givens["_tag"]

/** The clock answers are resolved against: `08s10f` means a different frame at 24 and 60 fps. */
export const Clock = Schema.Struct({ rate: Rate, frames: PositiveInt })
export type Clock = typeof Clock.Type

/** A later question in the same conversation, e.g. "now prove the change" after "make it snappier". */
export const FollowUp = Schema.Struct({ prompt: Schema.String, answer: Answer })
export type FollowUp = typeof FollowUp.Type

export const Task = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)),
  split: Split,
  /**
   * How the task's clip is opened. For synthetic tasks this is the ground-truth spec, which names the
   * answer in its parameters: the runner hands the model an opaque rendering instead (see Present.ts).
   */
  source: Schema.String,
  clock: Clock,
  givens: Givens,
  prompt: Schema.String,
  answer: Answer,
  followUps: Schema.Array(FollowUp)
})
export type Task = typeof Task.Type

export const TaskFile = Schema.Struct({ tasks: Schema.Array(Task) })
export type TaskFile = typeof TaskFile.Type
