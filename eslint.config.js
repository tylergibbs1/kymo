import tseslint from "typescript-eslint"

const noConsoleLog = {
  selector: "CallExpression[callee.object.name='console'][callee.property.name='log']",
  message: "stdout is reserved for JSON output; write through the shell's output module."
}
const spawnThroughRun = {
  selector: "CallExpression[callee.object.name='ChildProcess'][callee.property.name='make']",
  message: "Spawn processes through packages/sources/src/video/Run.ts so they are killed on interrupt."
}

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
    // Labels drawn on images and shown before them follow the server's label style, which reaches
    // views as an option. A fixed-style label or an environment read here would ignore it.
    files: ["packages/views/src/**/*.ts", "packages/kymo/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        noConsoleLog,
        spawnThroughRun,
        {
          selector: "CallExpression[callee.object.name='Address'][callee.property.name='label']",
          message: "Use Address.styledLabel(rate, index, style) with the label style passed in."
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: "Configuration arrives as typed options (see kymo's ServerConfig), not environment reads."
        }
      ]
    }
  }
)
