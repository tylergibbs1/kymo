/**
 * A compact Markdown rendering of a tool result's JSON, for the text block next to `structuredContent`.
 * Top-level fields become `**name**: value` lines, lists of flat records become tables, and nested
 * records become bullet lists. Every value in the JSON appears; nothing is added.
 */
type Scalar = string | number | boolean | null
type Record_ = { readonly [key: string]: unknown }

const isScalar = (v: unknown): v is Scalar => v === null || ["string", "number", "boolean"].includes(typeof v)
const isRecord = (v: unknown): v is Record_ => typeof v === "object" && v !== null && !Array.isArray(v)
const isFlat = (v: unknown): v is Record_ =>
  isRecord(v) && Object.values(v).every((x) => isScalar(x) || (Array.isArray(x) && x.every(isScalar)))

const scalar = (v: Scalar): string => (typeof v === "string" ? (v === "" ? '""' : v) : String(v))

const inline = (v: unknown): string =>
  isScalar(v)
    ? scalar(v)
    : Array.isArray(v)
      ? v.length === 0
        ? "none"
        : v.map((x) => (isRecord(x) ? `{${inline(x)}}` : inline(x))).join(", ")
      : isRecord(v)
        ? Object.entries(v)
            .map(([k, x]) => `${k}: ${isRecord(x) ? `{${inline(x)}}` : inline(x)}`)
            .join(", ")
        : String(v)

const cell = (v: unknown): string =>
  v === undefined ? "" : inline(v).replace(/\|/g, "\\|").replace(/\n/g, " ")

const table = (rows: ReadonlyArray<Record_>): ReadonlyArray<string> => {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  return [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${columns.map((c) => cell(r[c])).join(" | ")} |`)
  ]
}

const list = (record: Record_, depth: number): ReadonlyArray<string> => {
  const indent = "  ".repeat(depth)
  return Object.entries(record).flatMap(([k, v]) =>
    isRecord(v)
      ? [`${indent}- ${k}:`, ...list(v, depth + 1)]
      : Array.isArray(v) && v.length > 0 && v.every(isRecord)
        ? [`${indent}- ${k}:`, ...v.map((x) => `${indent}  - ${inline(x)}`)]
        : [`${indent}- ${k}: ${inline(v)}`]
  )
}

/** One top-level field: a line, or a blank-line-separated name and block. */
const field = (key: string, v: unknown): string => {
  if (Array.isArray(v) && v.length > 0 && v.every(isFlat)) return `\n**${key}**\n\n${table(v).join("\n")}\n`
  if (isRecord(v) || (Array.isArray(v) && v.length > 0 && v.every(isRecord)))
    return `\n**${key}**\n\n${(isRecord(v) ? list(v, 0) : v.map((x) => `- ${inline(x)}`)).join("\n")}\n`
  return `**${key}**: ${inline(v)}`
}

export const toMarkdown = (value: unknown): string =>
  isRecord(value)
    ? Object.entries(value)
        .map(([k, v]) => field(k, v))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : inline(value)
