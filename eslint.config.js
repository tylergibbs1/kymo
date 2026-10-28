import tseslint from "typescript-eslint"

const noConsoleLog = {
  selector: "CallExpression[callee.object.name='console'][callee.property.name='log']",
  message: "stdout is reserved for JSON output; write through the shell's output module."
}
const spawnThroughRun = {
  selector: "CallExpression[callee.object.name='ChildProcess'][callee.property.name='make']",
  message: "Spawn processes through packages/sources/src/video/Run.ts so they are killed on interrupt."
}

export default tseslint.config(
  { ignores: ["**/node_modules/**", "eval/reports/**"] },
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
