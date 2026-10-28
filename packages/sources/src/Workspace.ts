import { NodeServices } from "@effect/platform-node"
import {
  BackendFailure,
  FrameIndex,
  frameIndex,
  InvalidInput,
  type KymoError,
  MarkerName,
  type Source,
  SourceNotFound
} from "@kymo/core"
import { Context, Effect, FileSystem, Layer, Path, Result, Schema, type Scope, Semaphore } from "effect"
import { Sources } from "./Sources.ts"
import { makeMarker } from "./Timeline.ts"

const HANDLE = /^[A-Za-z_][\w-]*$/

/** A short name for an opened source, usable in addresses as `clip1@08s10f`. */
export const Handle = Schema.String.check(
  Schema.isPattern(HANDLE, { expected: "a handle: a letter or _, then letters, digits, _ or -" })
).pipe(Schema.brand("Handle"))
export type Handle = typeof Handle.Type

/** Where a saved marker came from: set by the agent, or found by scan. */
const SavedOrigin = Schema.Literals(["agent", "cut", "peak"])

const AgentMarker = Schema.Struct({
  name: MarkerName,
  index: FrameIndex,
  /** Absent in files written before scan saved its own kind; those read as "agent". */
  origin: Schema.optionalKey(SavedOrigin)
})
export type AgentMarker = typeof AgentMarker.Type

/** A marker scan found: its kind names it (`cut3`, `peak1`), its frame identifies it. */
export interface Detected {
  readonly kind: "cut" | "peak"
  readonly index: number
}

/** One remembered source. */
export const WorkspaceEntry = Schema.Struct({
  handle: Handle,
  input: Schema.String,
  /** Frames to shift this source by when aligning it with others (e.g. telemetry). */
  offset: Schema.Int,
  /** Markers the agent set; they appear on the opened Timeline with origin "agent". */
  markers: Schema.Array(AgentMarker)
})
export type WorkspaceEntry = typeof WorkspaceEntry.Type

const WorkspaceFile = Schema.Struct({ version: Schema.Literal(1), sources: Schema.Array(WorkspaceEntry) })
type WorkspaceFile = typeof WorkspaceFile.Type
const decodeFile = Schema.decodeUnknownResult(Schema.fromJsonString(WorkspaceFile))
const EMPTY: WorkspaceFile = { version: 1, sources: [] }

export interface RegisterOptions {
  /** Point an existing handle at a different input, dropping its markers and offset. */
  readonly replace?: boolean
}

export interface Resolved {
  readonly handle: Handle
  readonly input: string
}

/** Short handles for sources, persisted in `<root>/.kymo/handles.json`. */
export class Workspace extends Context.Service<
  Workspace,
  {
    /**
     * Name `input`. Reuses its existing handle, or picks `clip1`, `clip2`, … unless `as` is given.
     * A handle already naming another input fails with InvalidInput unless `replace` is set, so a
     * source and its saved markers are never lost by reusing a name.
     */
    register(input: string, as?: string, options?: RegisterOptions): Effect.Effect<Handle, KymoError>
    readonly list: Effect.Effect<ReadonlyArray<WorkspaceEntry>, KymoError>
    /** A known handle → its input. Otherwise a path, URL or spec, under its existing or next auto handle. */
    resolve(sourceOrHandle: string): Effect.Effect<Resolved, KymoError>
    /** Resolve and open, remembering new inputs and adding the agent's markers to the Timeline. */
    open(sourceOrHandle: string): Effect.Effect<Source, KymoError, Scope.Scope>
    setOffset(handle: string, frames: number): Effect.Effect<void, KymoError>
    /** Set (or move) an agent marker. The index must already be resolved against the source. */
    addMarker(handle: string, name: string, index: number): Effect.Effect<void, KymoError>
    /**
     * Save what a scan found and return each one's name, in order. A marker is identified by its
     * kind and frame: one already saved keeps its name, a new one gets the next number after every
     * saved one of its kind. Saved markers are never renamed, moved or dropped, so `@cut4` names the
     * same frame after any later scan, ranged or not.
     */
    saveDetected(
      handle: string,
      found: ReadonlyArray<Detected>
    ): Effect.Effect<ReadonlyArray<string>, KymoError>
  }
>()("@kymo/sources/Workspace") {
  /** A workspace whose state lives in `<root>/.kymo/handles.json`. */
  static readonly layerAt = (root: string): Layer.Layer<Workspace, never, Sources> =>
    Layer.effect(Workspace)(make(root)).pipe(Layer.provide(NodeServices.layer))

  /** A workspace in the current directory. */
  static readonly layer: Layer.Layer<Workspace, never, Sources> = Layer.unwrap(
    Effect.sync(() => Workspace.layerAt(process.cwd()))
  )
}

const storeFailure = (file: string) => (e: { readonly message: string }) =>
  new BackendFailure({
    message: `Could not access ${file}: ${e.message}`,
    hint: "Check the directory is writable."
  })

const invalid = (message: string, hint: string) => new InvalidInput({ message, hint })

const make = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sources = yield* Sources
  const lock = yield* Semaphore.make(1)
  const dir = path.join(root, ".kymo")
  const file = path.join(dir, "handles.json")

  const load = Effect.gen(function* () {
    if (!(yield* fs.exists(file))) return EMPTY
    const text = yield* fs.readFileString(file)
    const parsed = decodeFile(text)
    if (Result.isSuccess(parsed)) return parsed.success
    return yield* invalid(
      `${file} is not a valid workspace file: ${parsed.failure.message.replace(/\n\s*/g, " ")}`,
      "Fix it by hand, or delete it to forget all handles."
    )
  }).pipe(Effect.catchTag("PlatformError", (e) => Effect.fail(storeFailure(file)(e))))

  const save = (state: WorkspaceFile) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(dir, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      yield* fs.writeFileString(tmp, `${JSON.stringify(state, null, 2)}\n`)
      yield* fs.rename(tmp, file)
    }).pipe(Effect.mapError(storeFailure(file)))

  /** Read-modify-write under the lock, so concurrent calls can't lose each other's changes. */
  const update = <A, R>(
    f: (state: WorkspaceFile) => Effect.Effect<readonly [A, WorkspaceFile], KymoError, R>
  ): Effect.Effect<A, KymoError, R> =>
    lock.withPermit(
      Effect.gen(function* () {
        const state = yield* load
        const [result, next] = yield* f(state)
        if (next !== state) yield* save(next)
        return result
      })
    )

  const parseHandle = (text: string) =>
    Effect.fromResult(
      Result.mapError(Schema.decodeUnknownResult(Handle)(text), () =>
        invalid(
          `"${text}" is not a valid handle.`,
          "Handles start with a letter or _, then letters, digits, _ or -; e.g. clip1, hero_shot, page-2."
        )
      )
    )

  const notFound = (state: WorkspaceFile, ref: string) =>
    new SourceNotFound({
      message:
        state.sources.length > 0
          ? `No source "${ref}". Open sources: ${state.sources.map((s) => s.handle).join(", ")}.`
          : `No source "${ref}". No sources are open yet.`,
      hint: "Use one of those handles, or pass a file path, directory or synthetic: spec to open a new source."
    })

  const entryFor = (state: WorkspaceFile, handle: string) => {
    const entry = state.sources.find((s) => s.handle === handle)
    return entry ? Effect.succeed(entry) : Effect.fail(notFound(state, handle))
  }

  /** `prefix1`, `prefix2`, … : the first one no source has. */
  const freeName = (state: WorkspaceFile, prefix: string): Handle => {
    const taken = new Set<string>(state.sources.map((s) => s.handle))
    const stem = prefix.replace(/\d+$/, "")
    let n = stem === prefix ? 1 : 2
    while (taken.has(`${stem}${n}`)) n++
    return Handle.make(`${stem}${n}`)
  }

  const nextAutoHandle = (state: WorkspaceFile): Handle => freeName(state, "clip")

  const resolveIn = (state: WorkspaceFile, ref: string) =>
    Effect.gen(function* () {
      const known = state.sources.find((s) => s.handle === ref)
      if (known) return { handle: known.handle, input: known.input, entry: known }
      if (HANDLE.test(ref) && !(yield* fs.exists(ref).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* notFound(state, ref)
      }
      const existing = state.sources.find((s) => s.input === ref)
      if (existing) return { handle: existing.handle, input: ref, entry: existing }
      return { handle: nextAutoHandle(state), input: ref, entry: undefined }
    })

  const withEntry = (state: WorkspaceFile, entry: WorkspaceEntry): WorkspaceFile => {
    const at = state.sources.findIndex((s) => s.handle === entry.handle)
    return {
      ...state,
      sources: at < 0 ? [...state.sources, entry] : state.sources.map((s, i) => (i === at ? entry : s))
    }
  }

  const register = (input: string, as?: string, options?: RegisterOptions) =>
    update((state) =>
      Effect.gen(function* () {
        if (as === undefined) {
          const existing = state.sources.find((s) => s.input === input)
          if (existing) return [existing.handle, state] as const
          const handle = nextAutoHandle(state)
          return [handle, withEntry(state, { handle, input, offset: 0, markers: [] })] as const
        }
        const handle = yield* parseHandle(as)
        const current = state.sources.find((s) => s.handle === handle)
        if (current?.input === input) return [handle, state] as const
        if (current !== undefined && options?.replace !== true) {
          const saved = current.markers.length
          return yield* invalid(
            `${handle} already names ${current.input}${saved > 0 ? ` (with ${saved} saved marker${saved === 1 ? "" : "s"})` : ""}; it was not changed to ${input}.`,
            `Choose another name, e.g. ${freeName(state, handle)}, or pass replace (CLI --replace) to point ${handle} at ${input} and drop its markers.`
          )
        }
        return [handle, withEntry(state, { handle, input, offset: 0, markers: [] })] as const
      })
    )

  const open = (ref: string) =>
    update((state) =>
      Effect.gen(function* () {
        const { handle, input, entry } = yield* resolveIn(state, ref)
        const source = yield* sources.open(input, handle)
        const agent = (entry?.markers ?? []).map((m) =>
          makeMarker(source.timeline.rate, m.name, m.index, m.origin ?? "agent")
        )
        const names = new Set(agent.map((m) => m.name))
        const opened: Source = {
          ...source,
          timeline: {
            ...source.timeline,
            markers: [...source.timeline.markers.filter((m) => !names.has(m.name)), ...agent]
          }
        }
        const next = entry ? state : withEntry(state, { handle, input, offset: 0, markers: [] })
        return [opened, next] as const
      })
    )

  const setOffset = (handle: string, frames: number) =>
    update((state) =>
      Effect.gen(function* () {
        if (!Number.isInteger(frames)) {
          return yield* invalid(
            `Offset ${frames} is not a whole number of frames.`,
            "Use an integer like 12 or -3."
          )
        }
        const entry = yield* entryFor(state, handle)
        return [undefined, withEntry(state, { ...entry, offset: frames })] as const
      })
    )

  const addMarker = (handle: string, name: string, index: number) =>
    update((state) =>
      Effect.gen(function* () {
        const entry = yield* entryFor(state, handle)
        const marker = yield* Effect.fromResult(
          Result.mapError(Schema.decodeUnknownResult(AgentMarker)({ name, index }), () =>
            invalid(
              `Can't set marker "${name}" at #${index}.`,
              "Marker names are letters, digits and _ (not starting with a digit); the frame must be a resolved index ≥ 0."
            )
          )
        )
        const markers = [...entry.markers.filter((m) => m.name !== marker.name), marker]
        return [undefined, withEntry(state, { ...entry, markers })] as const
      })
    )

  const saveDetected = (handle: string, found: ReadonlyArray<Detected>) =>
    update((state) =>
      Effect.gen(function* () {
        const entry = yield* entryFor(state, handle)
        const markers = [...entry.markers]
        const numberOf = (kind: string, name: string) => {
          const m = new RegExp(`^${kind}(\\d+)$`).exec(name)
          return m ? Number(m[1]) : 0
        }
        const names = found.map(({ kind, index }) => {
          const same = markers.find((m) => numberOf(kind, m.name) > 0 && m.index === index)
          if (same) return same.name
          const next = Math.max(0, ...markers.map((m) => numberOf(kind, m.name))) + 1
          const marker = { name: `${kind}${next}`, index: frameIndex(index), origin: kind }
          markers.push(marker)
          return marker.name
        })
        const changed = markers.length !== entry.markers.length
        return [names, changed ? withEntry(state, { ...entry, markers }) : state] as const
      })
    )

  return Workspace.of({
    register,
    saveDetected,
    list: Effect.map(load, (s) => s.sources),
    resolve: (ref) =>
      Effect.map(
        Effect.flatMap(load, (state) => resolveIn(state, ref)),
        ({ handle, input }) => ({ handle, input })
      ),
    open,
    setOffset,
    addMarker
  })
})
