import tseslint from "typescript-eslint"

const noConsoleLog = {
  selector: "CallExpression[callee.object.name='console'][callee.property.name='log']",
  message: "stdout is reserved for JSON output; write through the shell's output module."
}
const spawnThroughRun = {
  selector: "CallExpression[callee.object.name='ChildProcess'][callee.property.name='make']",
  message: "Spawn processes through packages/sources/src/video/Run.ts so they are killed on interrupt."
}
const noEnvRead = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message: "Configuration arrives as typed options (see kymo's ServerConfig), not environment reads."
}

/**
 * A frame named in text (a finding, an assertion result, a note, a sheet label) follows the label
 * style (KYMO_LABEL_STYLE). The fixed-style forms are a canonical address or span written into a
 * template literal; JSON `address` fields keep them. Errors are exempt: they echo the address
 * grammar the caller typed, and core builds most of them without a style.
 */
const inText = (selector) => `TemplateLiteral:not(NewExpression *) > ${selector}`
const styledFrameText = [
  "CallExpression[callee.object.name='Address'][callee.property.name=/^(format|formatSpan)$/]",
  "CallExpression[callee.property.name='spanText']",
  "MemberExpression[property.name='address']"
].map((selector) => ({
  selector: inText(selector),
  message:
    "Name frames in text with Address.styledLabel, styledAddress or styledSpan, passing the label style in."
}))

/**
 * A doc comment on a Schema.Struct field is invisible to agents: `kymo schema` and MCP tool schemas
 * only carry `.annotate({ description })`. In the operation contract, describe fields that way.
 */
const schemaFieldDescriptions = {
  meta: {
    type: "problem",
    messages: {
      jsdoc:
        "Describe Schema fields with .annotate({ description }), not a doc comment: comments never reach `kymo schema`."
    }
  },
  create(context) {
    const isStruct = (call) =>
      call?.type === "CallExpression" &&
      call.callee.type === "MemberExpression" &&
      call.callee.object.name === "Schema" &&
      call.callee.property.name === "Struct"
    return {
      Property(node) {
        if (node.parent.type !== "ObjectExpression" || !isStruct(node.parent.parent)) return
        for (const c of context.sourceCode.getCommentsBefore(node))
          if (c.type === "Block" && c.value.startsWith("*"))
            context.report({ loc: c.loc, messageId: "jsdoc" })
      }
    }
  }
}

export default tseslint.config(
  { ignores: ["**/node_modules/**", "eval/reports/**", ".claude/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      // Errors cross the boundary as typed KymoErrors; a bare throw escapes the error channel.
      "no-restricted-syntax": ["error", noConsoleLog]
    }
  },
  {
    // Every ffmpeg/ffprobe process goes through video/Run.ts, which kills it on interrupt.
    // A process spawned elsewhere can hang when a read stops early.
    files: ["packages/**/*.ts", "apps/**/*.ts"],
    ignores: ["packages/sources/src/video/Run.ts"],
    rules: {
      "no-restricted-syntax": ["error", noConsoleLog, spawnThroughRun]
    }
  },
  {
    // Whole-frame motion depends on how much of the frame moves: a small element in a large still page
    // never reaches a floor tuned on full-frame footage. Pixel rules compare with the clip's own
    // statistics (packages/analysis/src/Signals.ts), never with a fixed number.
    files: ["packages/analysis/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        noConsoleLog,
        spawnThroughRun,
        ...styledFrameText,
        noEnvRead,
        {
          selector:
            "BinaryExpression[operator=/^[<>]=?$/]:matches([left.property.name=/^motion2?$/][right.raw=/^(?!0$)[0-9.]+$/], [right.property.name=/^motion2?$/][left.raw=/^(?!0$)[0-9.]+$/])",
          message:
            "Whole-frame motion is not comparable across clips. Compare with the clip's own statistics (Signals.ts), not a fixed number."
        }
      ]
    }
  },
  {
    files: ["packages/kymo/src/**/*.ts"],
    plugins: { kymo: { rules: { "schema-field-descriptions": schemaFieldDescriptions } } },
    rules: { "kymo/schema-field-descriptions": "error" }
  },
  {
    // Labels drawn on images and frames named in text follow the server's label style, which reaches
    // views, operations and analysis (its block above) as a required option, never an environment read.
    files: ["packages/views/src/**/*.ts", "packages/kymo/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", noConsoleLog, spawnThroughRun, ...styledFrameText, noEnvRead]
    }
  }
)
