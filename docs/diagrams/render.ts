/**
 * Render every `docs/diagrams/*.mmd` to `docs/images/<name>-light.svg` and `-dark.svg` with Pele, so
 * the README shows sleek static SVGs that GitHub can display. `--check` fails if any SVG is stale.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { render } from "pele"

const root = join(import.meta.dirname, "..", "..")
const sources = join(root, "docs", "diagrams")
const images = join(root, "docs", "images")

const themes = {
  light: {
    bg: "#ffffff",
    fg: "#1f2328",
    muted: "#59636e",
    line: "#8c959f",
    surface: "#f6f8fa",
    "surface-alt": "#eef1f4",
    border: "#d1d9e0",
    accent: "#3b9cff"
  },
  dark: {
    bg: "#0d1117",
    fg: "#f0f6fc",
    muted: "#9198a1",
    line: "#656c76",
    surface: "#151b23",
    "surface-alt": "#212830",
    border: "#3d444d",
    accent: "#3b9cff"
  }
} as const

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif"

/**
 * Pele colours everything through CSS variables, which an `<img>` SVG can't be relied on to resolve.
 * Set the theme as variables on the root, then replace every `var(...)` with its literal value.
 */
const themed = (svg: string, theme: (typeof themes)[keyof typeof themes]): string => {
  const vars = new Map<string, string>(Object.entries(theme).map(([k, v]) => [`--pele-${k}`, v]))
  vars.set("--pele-radius", "8px")
  vars.set("--pele-font", FONT)
  const style = /^<svg[^>]* style="([^"]*)"/.exec(svg)![1]!
  const resolve = (text: string): string =>
    text.replace(
      /var\((--[\w-]+)(?:,([^()]*(?:\([^()]*\))?[^()]*))?\)/g,
      (_, name: string, fallback?: string) => vars.get(name) ?? resolve(fallback ?? "")
    )
  const kept: Array<string> = []
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":")
    const name = decl.slice(0, i)
    if (name.startsWith("--")) vars.set(name, resolve(decl.slice(i + 1)))
    else kept.push(decl)
  }
  return resolve(svg.replace(style, kept.join(";")))
}

const check = process.argv.includes("--check")
const stale: Array<string> = []
for (const file of readdirSync(sources).filter((f) => f.endsWith(".mmd"))) {
  const { svg } = render(readFileSync(join(sources, file), "utf8"), { fontFamily: FONT, padding: 8 })
  for (const [name, theme] of Object.entries(themes)) {
    const out = join(images, `${basename(file, ".mmd")}-${name}.svg`)
    const text = `${themed(svg, theme)}\n`
    if (!check) writeFileSync(out, text)
    else if (!existsSync(out) || readFileSync(out, "utf8") !== text) stale.push(out)
  }
}
if (stale.length > 0) {
  process.stderr.write(`Stale diagrams (run bun run docs:diagrams):\n${stale.join("\n")}\n`)
  process.exit(1)
}
