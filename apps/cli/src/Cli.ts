import { NodeServices } from "@effect/platform-node"
import {
  BackendFailure,
  InvalidInput,
  type KymoError,
  VERDICT_FAILED_EXIT,
  exitCodes,
  toPayload
} from "@kymo/core"
import { VERSION, httpServer, stdioServer } from "@kymo/mcp"
import {
  type AnyOperation,
  decodeInput,
  encodeOutput,
  flatInputSchema,
  fromEnv,
  kymoLayer,
  operations,
  schemasOf,
  toLines
} from "kymo"
import { Cause, Data, Effect, Exit, Fiber, Layer, Logger, Option, Result } from "effect"
import { Argument, CliError, CliOutput, Command, Flag } from "effect/cli"
import { type Field, fieldsOf, inputOf, normalize, paramsOf, valueFlags } from "./Flags.ts"
import * as Output from "./Output.ts"

const invalid = (message: string, hint: string) => new InvalidInput({ message, hint })

/** The result was printed and is a failure (a check that did not pass): exit `VERDICT_FAILED_EXIT`. */
class VerdictFailed extends Data.TaggedError("VerdictFailed") {}

const fieldsByOp = new Map(operations.map((op) => [op.name, fieldsOf(flatInputSchema(op))] as const))
const fieldsFor = (op: AnyOperation): ReadonlyArray<Field> => fieldsByOp.get(op.name)!

const COMMANDS = [...operations.map((op) => op.name), "schema", "mcp"]

const parseJson = (text: Option.Option<string>): Effect.Effect<Record<string, unknown>, InvalidInput> => {
  if (Option.isNone(text)) return Effect.succeed({})
  const parsed = Result.try(() => JSON.parse(text.value) as unknown)
  return Result.isSuccess(parsed) &&
    typeof parsed.success === "object" &&
    parsed.success !== null &&
    !Array.isArray(parsed.success)
    ? Effect.succeed(parsed.success as Record<string, unknown>)
    : Effect.fail(
        invalid(
          `--json ${text.value} is not a JSON object.`,
          `Quote the whole object, e.g. --json '{"source":"clip1","at":["0f"]}'.`
        )
      )
}

/** JSON Lines ops print the lines their published `lines` schemas describe; the rest print one value. */
const print = (op: AnyOperation, result: unknown) =>
  op.lines === undefined || typeof result !== "object" || result === null
    ? Output.json(result)
    : Output.lines(toLines(op.lines, result as Record<string, unknown>))

const opCommand = (op: AnyOperation) => {
  const fields = fieldsFor(op)
  return Command.make(op.name, paramsOf(fields), (values: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
      const payload = yield* parseJson(values["json"] as Option.Option<string>)
      const raw = { ...payload, ...inputOf(fields, values) }
      const out = Option.getOrUndefined(values["out"] as Option.Option<string>)
      const output = yield* decodeInput(op, raw).pipe(
        Effect.flatMap((input) => op.run(input)),
        Effect.provide(kymoLayer({ out }))
      )
      yield* print(op, yield* encodeOutput(op, output))
      if (op.passed?.(output) === false) return yield* new VerdictFailed()
    })
  ).pipe(
    Command.withDescription(
      `${op.description} Images: ${op.cost}.${
        op.lines === undefined
          ? " Prints one JSON value."
          : ` Prints JSON Lines: one of ${op.lines.field} per line, then a summary line (\`kymo schema ${op.name}\` → lines).`
      }${op.passed === undefined ? "" : ` Exits ${VERDICT_FAILED_EXIT} when the result does not pass.`}`
    )
  )
}

const schemaCommand = Command.make(
  "schema",
  {
    command: Argument.String("command").pipe(
      Argument.withDescription(`One of ${operations.map((o) => o.name).join(", ")}.`),
      Argument.optional
    ),
    all: Flag.Boolean("all").pipe(Flag.withDescription("Print every command's schemas."), Flag.optional)
  },
  ({ command }) =>
    Effect.gen(function* () {
      const io = (op: AnyOperation) => {
        const { name: _name, description: _description, ...schemas } = schemasOf(op)
        return schemas
      }
      if (Option.isNone(command))
        return yield* Output.json(Object.fromEntries(operations.map((op) => [op.name, io(op)])))
      const op = operations.find((o) => o.name === command.value)
      if (op === undefined)
        return yield* invalid(
          `There is no command "${command.value}".`,
          `Commands with schemas: ${operations.map((o) => o.name).join(", ")}; or pass --all.`
        )
      yield* Output.json(io(op))
    })
).pipe(
  Command.withDescription("Print the JSON Schemas of a command's input and output (all commands with --all).")
)

const PORT = /^:?(\d{1,5})$/

const mcpCommand = Command.make(
  "mcp",
  {
    http: Flag.String("http").pipe(
      Flag.withDescription("Serve Streamable HTTP on this port (:3333) instead of stdio."),
      Flag.optional
    ),
    out: Flag.String("out").pipe(Flag.withDescription("Directory for images."), Flag.optional)
  },
  ({ http, out }) =>
    Effect.gen(function* () {
      const config = yield* fromEnv(process.env)
      const dir = Option.getOrUndefined(out)
      if (Option.isNone(http)) {
        // When the client closes stdin the server interrupts the fiber that started it. Run it in a
        // child fiber, so ending the session is a clean exit rather than an interrupted CLI.
        const server = yield* Effect.forkChild(Layer.launch(stdioServer(config, dir)))
        const exit = yield* Fiber.await(server)
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
          return yield* Effect.failCause(exit.cause)
        return
      }
      const port = PORT.exec(http.value)
      if (port === null)
        return yield* invalid(`--http ${http.value} is not a port.`, "Write the port like :3333 or 3333.")
      return yield* Layer.launch(httpServer(config, Number(port[1]), dir))
    })
).pipe(
  Command.withDescription("Run the kymo MCP server: stdio by default, or Streamable HTTP with --http :port.")
)

const root = Command.make("kymo").pipe(
  Command.withDescription(
    "See and measure motion. Every frame has one address: 08s10f, #250, -1f, @impact+5f, 2s..4s:2f."
  ),
  Command.withSubcommands([...operations.map(opCommand), schemaCommand, mcpCommand])
)

/** Help and version go to stdout only when asked for; parse errors are reported as JSON instead. */
const presenter = CliOutput.layerPresenter({
  present: (event) =>
    event._tag === "Help" && event.reason === "Requested"
      ? Effect.gen(function* () {
          const formatter = yield* CliOutput.Formatter
          yield* Output.help(formatter.formatHelpDoc(event.helpDoc))
        })
      : event._tag === "Version"
        ? Output.help(`${event.name} ${event.version}`)
        : Effect.void
})

const flagList = (command: ReadonlyArray<string> | undefined): string => {
  const op = operations.find((o) => o.name === command?.[1])
  return op === undefined
    ? `Commands: ${COMMANDS.join(", ")}.`
    : `Flags for ${op.name}: ${[
        ...valueFlags(fieldsFor(op)).keys(),
        ...fieldsFor(op)
          .filter((f) => f.kind._tag === "switch")
          .map((f) => f.flag)
      ]
        .map((f) => `--${f}`)
        .join(", ")}.`
}

/** One parse error as kymo's error shape. Suggestions ("did you mean") are deliberately dropped. */
const parseError = (e: CliError.NonShowHelpErrors, path: ReadonlyArray<string>): InvalidInput => {
  const usage = `See \`${path.join(" ")} --help\`.`
  switch (e._tag) {
    case "UnrecognizedOption":
      return invalid(
        `Unknown flag ${e.option} for \`${(e.command ?? path).join(" ")}\`.`,
        `${flagList(e.command ?? path)} ${usage}`
      )
    case "UnknownSubcommand":
      return invalid(`Unknown command "${e.subcommand}".`, `Commands: ${COMMANDS.join(", ")}.`)
    case "InvalidValue":
      return invalid(
        `--${e.option} ${JSON.stringify(e.value)} is not valid: ${e.expected.toLowerCase()}.`,
        usage
      )
    case "UnexpectedArgument":
      return invalid(
        `Unexpected argument${e.arguments.length > 1 ? "s" : ""} ${e.arguments.join(" ")}.`,
        `Put the source first, then flags; give several addresses after one flag: --at 0f 1s -1f. ${usage}`
      )
    default:
      return invalid(e.message, usage)
  }
}

const fromCliError = (e: CliError.CliError): InvalidInput =>
  e._tag === "ShowHelp"
    ? e.errors[0] !== undefined
      ? parseError(e.errors[0], e.commandPath)
      : invalid(
          e.commandPath.length <= 1
            ? "No command given."
            : `\`${e.commandPath.join(" ")}\` needs a subcommand.`,
          `Commands: ${COMMANDS.join(", ")}. See \`kymo --help\`.`
        )
    : parseError(e, ["kymo"])

const isKymoError = (e: unknown): e is KymoError =>
  typeof e === "object" && e !== null && "_tag" in e && (e as { _tag: string })._tag in exitCodes

const report = (e: KymoError) => Effect.as(Output.error(toPayload(e)), exitCodes[e._tag])

/**
 * Run the CLI on `argv` (without `node` and the script) and return the exit code. Never fails: every
 * error, including a bug, is printed as `{tag, message, hint}` on stderr.
 */
export const run = (argv: ReadonlyArray<string>): Effect.Effect<number> =>
  Command.runWith(root, { version: VERSION, renderErrors: false })(
    normalize(argv, (name) => {
      const op = operations.find((o) => o.name === name)
      return op === undefined ? undefined : valueFlags(fieldsFor(op))
    })
  ).pipe(
    Effect.as(0),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.succeed(130)
      const error = Cause.findError(cause)
      if (Result.isSuccess(error)) {
        const e: unknown = error.success
        if (e instanceof VerdictFailed) return Effect.succeed(VERDICT_FAILED_EXIT)
        if (CliError.isCliError(e)) return report(fromCliError(e))
        if (isKymoError(e)) return report(e)
      }
      const defect = Cause.squash(cause)
      return report(
        new BackendFailure({
          message: `kymo failed unexpectedly: ${defect instanceof Error ? defect.message : String(defect)}`,
          hint: "This is a kymo bug, not an input problem; report it with the command that failed."
        })
      )
    }),
    Effect.provide(Layer.mergeAll(presenter, NodeServices.layer, Layer.succeed(Logger.LogToStderr)(true)))
  )
