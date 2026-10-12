// Flat-pattern outline of a hockey jersey on a hanger, in metres.
// Local frame: origin at the top of the collar, +x to the wearer's left (viewer's right
// when facing the camera), +y up, so the whole garment lives at y <= 0.

export type Vec2 = [number, number]

// Adult L replica proportions: ~66 cm chest, ~80 cm body, ~56 cm sleeve. On a hanger the
// sleeves drop ~55° below horizontal and hang close along the body.
const RIGHT_HALF: Vec2[] = [
  [0.0, -0.02], // collar dip, centre front
  [0.095, 0.0], // collar edge
  [0.235, -0.05], // shoulder point
  [0.556, -0.509], // cuff, outer
  [0.392, -0.632], // cuff, inner
  [0.318, -0.335], // armpit
  [0.326, -0.62], // side seam
  [0.336, -0.83], // hem corner
  [0.0, -0.845], // hem, centre
]

/** Chaikin corner cutting: fabric edges are soft, never sharp polygon corners. */
function chaikin(poly: Vec2[], iterations: number): Vec2[] {
  let out = poly
  for (let it = 0; it < iterations; it++) {
    const next: Vec2[] = []
    for (let i = 0; i < out.length; i++) {
      const a = out[i]
      const b = out[(i + 1) % out.length]
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
    }
    out = next
  }
  return out
}

/** Closed outline, counter-clockwise, collar → right side → hem → left side, with
 *  rounded corners. */
export const SILHOUETTE: Vec2[] = (() => {
  const right = RIGHT_HALF
  const left = RIGHT_HALF.slice(1, -1)
    .reverse()
    .map(([x, y]) => [-x, y] as Vec2)
  // right half runs collar → hem; walk back up the left half
  return chaikin([...right, ...left], 2)
})()

const xs = SILHOUETTE.map(([x]) => x)
const ys = SILHOUETTE.map(([, y]) => y)
export const BOUNDS = {
  minX: -Math.max(...xs),
  maxX: Math.max(...xs),
  minY: Math.min(...ys),
  maxY: Math.max(...ys),
  get width() {
    return this.maxX - this.minX
  },
  get height() {
    return this.maxY - this.minY
  },
}

/** Where the hanger bar touches the shoulders, used for pinning the cloth. */
export const SHOULDER_PINS: Vec2[] = [
  [-0.205, -0.043],
  [-0.13, -0.022],
  [-0.06, -0.008],
  [0.06, -0.008],
  [0.13, -0.022],
  [0.205, -0.043],
]

/** Named landmarks the kit art and AO bake use (right side; mirror x for the left). */
export const LANDMARKS = {
  shoulder: RIGHT_HALF[2],
  cuffOuter: RIGHT_HALF[3],
  cuffInner: RIGHT_HALF[4],
  armpit: RIGHT_HALF[5],
  hemCorner: RIGHT_HALF[7],
}

function pointInPolygon(x: number, y: number, poly: Vec2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function distToSegment(px: number, py: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy))
}

/** Signed distance to the outline: positive inside, negative outside. */
export function signedDistance(x: number, y: number, poly: Vec2[] = SILHOUETTE): number {
  let d = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    d = Math.min(d, distToSegment(x, y, poly[j], poly[i]))
  }
  return pointInPolygon(x, y, poly) ? d : -d
}
