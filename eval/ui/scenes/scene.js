/*
 * Shared scene runtime. A scene page reads its parameters from the query string, builds its DOM and
 * Web Animations, then calls Scene.define. The capture command drives every page the same way:
 * SCENE.render(i) seeks every animation to frame i (and lets the scene set styles directly), then
 * SCENE.truth() reads what the browser actually laid out. Answers come from that truth, never from
 * the parameters.
 */
;(function () {
  const query = new URLSearchParams(location.search)

  const num = (key, fallback) => (query.has(key) ? Number(query.get(key)) : fallback)
  const str = (key, fallback) => query.get(key) ?? fallback
  const list = (key) =>
    (query.get(key) ?? "")
      .split(",")
      .filter((s) => s.length > 0)
      .map(Number)

  /** Opacity as seen on screen: the element's own times every ancestor's. */
  const effectiveOpacity = (el) => {
    let o = 1
    for (let e = el; e instanceof Element; e = e.parentElement) {
      const style = getComputedStyle(e)
      if (style.display === "none" || style.visibility === "hidden") return 0
      o *= Number(style.opacity)
    }
    return o
  }

  /**
   * elements: name -> Element whose box and opacity are recorded every frame.
   * scalars: name -> (i) => number, for truth that is not a box (a page's step counter, say).
   * render: (i, ms) => void, for scenes that set styles directly instead of animating.
   */
  const define = ({ frames, elements, scalars = {}, render = () => {} }) => {
    const fps = num("fps", 60)
    window.SCENE = {
      fps,
      frames: num("frames", frames),
      width: window.innerWidth,
      height: window.innerHeight,
      render(i) {
        const ms = (i * 1000) / fps
        for (const a of document.getAnimations()) {
          a.pause()
          a.currentTime = ms
        }
        render(i, ms)
      },
      truth(i) {
        const out = {}
        for (const [name, el] of Object.entries(elements)) {
          const r = el.getBoundingClientRect()
          out[`${name}.x`] = r.x
          out[`${name}.y`] = r.y
          out[`${name}.w`] = r.width
          out[`${name}.h`] = r.height
          out[`${name}.opacity`] = effectiveOpacity(el)
        }
        for (const [name, f] of Object.entries(scalars)) out[name] = f(i)
        return out
      }
    }
  }

  /** A loading spinner: a distractor that never stops turning. */
  const spinner = (left, top, size = 64) => {
    const el = document.createElement("div")
    el.className = "spinner"
    Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${size}px`, height: `${size}px` })
    document.body.appendChild(el)
    el.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
      duration: 800,
      iterations: Infinity,
      easing: "linear"
    })
    return el
  }

  /** A still dashboard behind the animation: a header bar and grey text lines. */
  const backdrop = (parent = document.body, title = "Acme Dashboard") => {
    const html = [`<div class="hdr">${title}</div>`]
    for (const [left, top, width] of [
      [40, 100, 500],
      [40, 130, 380],
      [40, 160, 440],
      [700, 100, 520],
      [700, 130, 300],
      [40, 600, 1180],
      [40, 630, 900]
    ])
      html.push(`<div class="line" style="left:${left}px;top:${top}px;width:${width}px"></div>`)
    parent.insertAdjacentHTML("afterbegin", html.join(""))
  }

  window.Scene = { num, str, list, define, spinner, backdrop }
})()
