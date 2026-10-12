/**
 * Put-back hand-off between the two canvases: the rack reports when it has drawn a frame
 * with the returned jersey visible again; only then does the modal let its copy go, so
 * the swap happens under identical pixels instead of on a timer.
 */
type Listener = () => void

let waiting: Listener[] = []

export const handoff = {
  /** Rack side: a frame with the jersey back on the rail has been drawn. */
  rackDrawn() {
    const list = waiting
    waiting = []
    list.forEach((fn) => fn())
  },
  /** Modal side: run `fn` once the rack has drawn its copy. Returns a cancel function. */
  whenRackDrawn(fn: Listener) {
    waiting.push(fn)
    return () => {
      waiting = waiting.filter((f) => f !== fn)
    }
  },
}
