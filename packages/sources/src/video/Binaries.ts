import { AdapterUnavailable } from "@kymo/core"
import { delimiter } from "node:path"
import { Config, Effect, FileSystem, Option, Path } from "effect"

/** Absolute paths of the two binaries the video adapter runs. */
export interface Binaries {
  readonly ffmpeg: string
  readonly ffprobe: string
}

const INSTALL = "On macOS: brew install ffmpeg. On Debian/Ubuntu: apt install ffmpeg."

const isExecutableFile = (fs: FileSystem.FileSystem, file: string) =>
  fs.stat(file).pipe(
    Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
    Effect.orElseSucceed(() => false)
  )

const locate = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  name: "ffmpeg" | "ffprobe",
  envVar: string
) {
  const unavailable = (detail: string) =>
    new AdapterUnavailable({
      message: `${name} not found. Install it, or set ${envVar}.`,
      hint: `${detail} ${INSTALL}`
    })
  const configured = yield* Config.option(Config.String(envVar)).pipe(Effect.orDie)
  if (Option.isSome(configured)) {
    const file = configured.value
    if (yield* isExecutableFile(fs, file)) return file
    return yield* unavailable(`${envVar} is "${file}", which is not an executable file.`)
  }
  const searchPath = yield* Config.option(Config.String("PATH")).pipe(Effect.orDie)
  for (const dir of Option.getOrElse(searchPath, () => "").split(delimiter)) {
    if (dir.length === 0) continue
    const file = path.join(dir, name)
    if (yield* isExecutableFile(fs, file)) return file
  }
  return yield* unavailable(`${name} is not on PATH and ${envVar} is not set.`)
})

/** Find ffmpeg and ffprobe from KYMO_FFMPEG / KYMO_FFPROBE, falling back to PATH. */
export const locateBinaries = (fs: FileSystem.FileSystem, path: Path.Path) =>
  Effect.all({
    ffmpeg: locate(fs, path, "ffmpeg", "KYMO_FFMPEG"),
    ffprobe: locate(fs, path, "ffprobe", "KYMO_FFPROBE")
  })
