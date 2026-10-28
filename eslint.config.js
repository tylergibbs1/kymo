import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["**/node_modules/**", "eval/reports/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      // Errors cross the boundary as typed KymoErrors; a bare throw escapes the error channel.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='console'][callee.property.name='log']",
          message: "stdout is reserved for JSON output; write through the shell's output module."
        }
      ]
    }
  },
  {
    // Every ffmpeg/ffprobe process goes through video/Run.ts, which kills it on interrupt.
    // A process spawned elsewhere can hang when a read stops early.
    files: ["packages/**/*.ts", "apps/**/*.ts"],
    ignores: ["packages/sources/src/video/Run.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='console'][callee.property.name='log']",
          message: "stdout is reserved for JSON output; write through the shell's output module."
        },
        {
          selector: "CallExpression[callee.object.name='ChildProcess'][callee.property.name='make']",
          message:
            "Spawn processes through packages/sources/src/video/Run.ts so they are killed on interrupt."
        }
      ]
    }
  }
)
