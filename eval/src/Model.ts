/**
 * The model side of the loop. A backend opens a conversation; the loop feeds it user text or tool
 * results and gets back a turn: some text, maybe tool calls, and the tokens it cost.
 */
import { type Effect, Schema } from "effect"
import type { Task } from "./Task.ts"
import type { ToolCall, ToolOutcome, ToolSpec } from "./Tools.ts"

export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
}

export const noUsage: Usage = { inputTokens: 0, outputTokens: 0 }

export interface Turn {
  readonly text: string
  /** Empty when the model is done talking for now; its text is then the reply that gets scored. */
  readonly calls: ReadonlyArray<ToolCall>
  readonly usage: Usage
  /** The model declined (a safety refusal). Scored as no answer. */
  readonly refused: boolean
}

export type Input =
  | { readonly _tag: "user"; readonly text: string }
  | {
      readonly _tag: "results"
      readonly results: ReadonlyArray<{ readonly call: ToolCall; readonly outcome: ToolOutcome }>
    }

export interface Conversation {
  readonly send: (input: Input) => Effect.Effect<Turn, ModelError>
}

export interface Session {
  readonly system: string
  readonly tools: ReadonlyArray<ToolSpec>
  /** The first user message: where the clip is, then the question. */
  readonly prompt: string
  /** The source string named in the prompt (an opaque rendering for synthetic tasks). */
  readonly source: string
  /**
   * What the question states, typed. Real-model adapters ignore this (they read the prompt); the
   * scripted oracle picks its strategy from it. The answer is never part of a session.
   */
  readonly givens: Task["givens"]
  readonly clock: Task["clock"]
}

export interface ModelBackend {
  readonly id: string
  readonly start: (session: Session) => Effect.Effect<Conversation, ModelError>
}

/** The API call failed (network, rate limit after retries, bad request). */
export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  model: Schema.String,
  message: Schema.String
}) {}

/** The named model has no working adapter in this environment. */
export class ModelNotConfigured extends Schema.TaggedError<ModelNotConfigured>()("ModelNotConfigured", {
  model: Schema.String,
  message: Schema.String
}) {}
