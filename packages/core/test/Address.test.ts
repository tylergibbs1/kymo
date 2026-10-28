import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { Address, Marker, frameIndex, rate } from "@kymo/core"

const r30 = rate(30)
const ctx: Address.ResolveContext = {
  handle: "clip1",
  kind: "video",
  rate: r30,
  first: 0,
  count: 222, // 07s12f
  live: false,
  markers: [{ name: "impact", index: 40 }]
}

const resolve = (text: string) => Result.flatMap(Address.parse(text), (a) => Address.resolve(ctx, a))
const ok = (text: string) => {
  const r = resolve(text)
  if (Result.isFailure(r)) throw new Error(`${text}: ${r.failure.message}`)
  return r.success
}
const err = (text: string) => {
  const r = resolve(text)
  if (Result.isSuccess(r)) throw new Error(`${text} resolved to ${r.success}`)
  return r.failure
}

describe("format", () => {
  it("matches the canonical examples", () => {
    expect(Address.format(r30, 250)).toBe("08s10f")
    expect(Address.format(r30, 65 * 30)).toBe("01m05s")
    expect(Address.format(r30, 0)).toBe("0f")
    expect(Address.format(r30, 20)).toBe("20f")
    expect(Address.format(r30, 3600 * 30 + 1)).toBe("1h01f")
    expect(Address.label(r30, 250)).toBe("08s10f #250")
    expect(Address.styledLabel(r30, 250, "both")).toBe("08s10f #250")
    expect(Address.styledLabel(r30, 250, "timecode")).toBe("08s10f")
    expect(Address.styledLabel(r30, 250, "index")).toBe("#250")
    expect(Address.spanName(r30, 0, 250)).toBe("0f-08s10f")
  })

  it("pads frames to the width of the timecode base", () => {
    expect(Address.format(rate(120), 125)).toBe("01s005f")
  })

  it("round-trips every frame exactly, including NTSC rates", () => {
    for (const r of [r30, rate(24), rate(30000, 1001), rate(120)]) {
      for (let i = 0; i < 5000; i += 7) {
        const back = Result.flatMap(Address.parse(Address.format(r, i)), (a) =>
          Address.resolve({ ...ctx, rate: r, count: 10_000 }, a)
        )
        expect(back).toEqual(Result.succeed([frameIndex(i)]))
      }
    }
  })
})

describe("parse + resolve", () => {
  it("resolves every point form", () => {
    expect(ok("05s10f")).toEqual([160])
    expect(ok("#200")).toEqual([200])
    expect(ok("1.5s")).toEqual([45])
    expect(ok("500ms")).toEqual([15])
    expect(ok("-1f")).toEqual([221])
    expect(ok("-1s")).toEqual([192])
    expect(ok("@impact")).toEqual([40])
    expect(ok("@impact+5f")).toEqual([45])
    expect(ok("@impact-1s")).toEqual([10])
    expect(ok("clip1@#3")).toEqual([3])
  })

  it("resolves ranges with steps; a bare step counts frames", () => {
    expect(ok("#0..#90:30")).toEqual([0, 30, 60, 90])
    expect(ok("2s..3s:10f")).toEqual([60, 70, 80, 90])
    expect(ok("#5..#7")).toEqual([5, 6, 7])
  })

  it("keeps the handle prefix", () => {
    const a = Address.parse("clip2@@impact+2f")
    expect(Result.isSuccess(a) && a.success.handle).toBe("clip2")
  })

  it("rejects malformed text with a fixable message", () => {
    for (const bad of ["8s10", "", "#x", "abc", "1..2..3", "#0..#9:zz", "250"]) {
      const e = err(bad)
      expect(e._tag).toBe("AddressParseError")
      expect(e.message).toContain("is not an address")
    }
    expect(err("250").message).toContain("#250")
  })

  it("reports out-of-range addresses with the duration and last frame", () => {
    const e = err("08s10f")
    expect(e._tag).toBe("AddressOutOfRange")
    expect(e.message).toBe("08s10f is past the end (duration 07s12f). The last frame is -1f.")
    expect(err("-300f")._tag).toBe("AddressOutOfRange")
    expect(err("#9..#2").hint).toContain("2f..9f")
  })

  it("only allows now on live sources", () => {
    expect(err("now-2s").message).toContain("only works on live sources")
    const live = { ...ctx, live: true, kind: "live", first: 100, count: 60 }
    const r = (t: string) => Result.flatMap(Address.parse(t), (a) => Address.resolve(live, a))
    expect(r("now")).toEqual(Result.succeed([159]))
    expect(r("now-1s")).toEqual(Result.succeed([129]))
    const old = r("#10")
    expect(Result.isFailure(old) && old.failure._tag).toBe("NotSeekable")
  })

  it("names known markers when one is missing", () => {
    expect(err("@nope").hint).toBe("Markers: @impact.")
  })
})

describe("Marker", () => {
  it("refuses names the grammar could not address", () => {
    const decode = Schema.decodeUnknownResult(Marker)
    expect(Result.isFailure(decode({ name: "impact-1", index: 1, address: "1f", origin: "agent" }))).toBe(
      true
    )
    expect(Result.isSuccess(decode({ name: "cut_1", index: 1, address: "1f", origin: "cut" }))).toBe(true)
  })
})
