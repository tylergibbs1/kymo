import { type ServerConfig, kymoLayer } from "kymo"
import { Layer } from "effect"
import { layerHttp, layerStdio } from "./Mcp.ts"
import { serverSpec } from "./Server.ts"

export { ImagesMode, INSTRUCTIONS, serverSpec, sheetUri } from "./Server.ts"

export const VERSION = "0.0.0"

/** The kymo MCP server over stdio, with images under `out` (default: a fresh temp directory). */
export const stdioServer = (config: ServerConfig, out?: string) =>
  layerStdio(serverSpec(config, VERSION)).pipe(
    Layer.provide(kymoLayer({ out, labelStyle: config.labelStyle }))
  )

/** The kymo MCP server over Streamable HTTP at `http://localhost:<port>/mcp`. */
export const httpServer = (config: ServerConfig, port: number, out?: string) =>
  layerHttp(serverSpec(config, VERSION), port).pipe(
    Layer.provide(kymoLayer({ out, labelStyle: config.labelStyle }))
  )
