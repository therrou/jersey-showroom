// Position-based cloth (XPBD, "small steps": many substeps, one constraint pass each).
// Runs inside a worker. Pure math, no three.js.
//
// World frame matches the modal scene: the hanger pivot is where the hook meets an
// (invisible) rail; the garment hangs below it in -y.
//
// Material model (the standard XPBD cloth recipe):
//   - stretch: every edge, stiff in tension, soft in compression so the knit buckles into
//     fresh folds instead of staying a smooth sheet (Choi & Ko 2002)
//   - bending: signed dihedral angle across every interior edge (Bridson et al. 2003),
//     resting near flat (seams keep their crease): folds come from gravity and motion,
//     not from a stored shape
//   - self-collision: particle-particle with a spatial hash (Müller, Ten Minute Physics
//     #15); it keeps the tube open and the sleeves in front of the body
//   - long-range attachments: each particle may not drift further from its nearest pin
//     than the geodesic distance (Kim, Chentanez & Müller 2012), so soft fabric can't sag
//   - damping removes only deformation, never rigid motion (Müller et al. 2007, §3.5)
//   - the hanger is a rigid body hanging from a ball-joint hook: the pins are its
//     particles, shape-matched about the hook each substep, so the cloth's mass drives
//     the swing (two-way coupling)

export interface ClothInit {
  particles: Float32Array // rest positions in garment space (collar at origin)
  edges: Uint32Array
  thickness: Uint32Array
  pins: Uint32Array
  triangles: Uint32Array // particle-index triangles (bending, aero drag)
  /** Flat-pattern xy per particle, if known: stretch rests on the uncompressed fabric. */
  pattern?: Float32Array
  draped: boolean // rest positions are already the hanging drape (GLB): keep them as is
  drop: number // pivot → collar
  seed: number // per-jersey drape variation
  substeps: number
  start: { x: number; y: number; z: number; yaw: number }
}

/** Live tuning (see src/config/physics.ts → modal). */
export interface ClothConfig {
  glideStiffness: number
  glideMaxAccel: number
  /** Hook friction (1/s): how quickly the hanger's swing dies out. */
  swingDamping: number
  flipStiffness: number
  flipDamping: number
  /** Dihedral bending compliance (1/(N·m)); higher = softer, floppier fabric. */
  bendCompliance: number
  /** How much of the drape's curvature the bending rest angle keeps (0 = flat). */
  bendRestKeep: number
  aero: number
  /** Grab: attachment compliance (m/N), soft patch radius (m), how far fabric may be
   *  pulled from where it hangs (m), falloff toward the patch edge. */
  grabCompliance: number
  grabRadius: number
  grabMaxPull: number
  grabFalloff: number
  /** Deformation damping (1/s); extra for a moment after letting go. */
  damping: number
  releaseDamping: number
  releaseTime: number
  /** Fabric stretch compliance in tension (0 = inextensible) and in compression. */
  stretchCompliance: number
  compressionCompliance: number
  /** Self-collision thickness as a fraction of the mean edge length (0 = off). */
  selfCollision: number
  /** Particle speed cap (m/s): a safety net, not a feel knob. */
  maxSpeed: number
}

export interface ClothTarget {
  x: number
  y: number
  z: number
  yaw: number
  /** Override the glide for this move (lift-off / put-back are quicker than a carousel step). */
  glide?: { stiffness: number; maxAccel: number }
  /** A scripted move (the put-back): barely swing while it's being carried. */
  calm?: boolean
  /** Display blend (0–1) from the simulated cloth to the rest drape hanging still at this
   *  target: the put-back lands exactly on the rack's static copy. Physics is unaffected. */
  rest?: number
}

export interface ClothInput {
  dt: number
  cfg: ClothConfig
  target: ClothTarget
  wind: { x: number; y: number; z: number; vx: number; vy: number; vz: number; r: number; on: boolean }
  grab: { id: number; x: number; y: number; z: number } | null
}

const GRAVITY = -9.81
const MASS = 0.42 // kg, a replica jersey
const HANGER_MASS = 0.15 // kg, spread over the pins
// Rest-shape drape for the flat procedural pattern: soft vertical folds that deepen toward
// the hem, and the hem gathers in slightly.
const FOLD_DEPTH = 0.02
const HEM_GATHER = 0.04

const SWING_MAX = 0.6
/** Extra deformation damping (1/s) and swing straightening (1/s) while carried. */
const CARRY_DAMPING = 5
const CARRY_STRAIGHTEN = 8
const CARRY_HOOK_FRICTION = 6
/** Front↔back particles never get closer than this fraction of their rest separation. */
const VOLUME_MIN = 0.25
/** Long-range attachments allow this much slack over the geodesic rest distance. */
const LRA_SLACK = 1.03
/** Pattern lengths further than this from the drape's are treated as bad data. */
const PATTERN_MAX_RATIO = 1.25
const COLLISION_FRICTION = 0.1
/** Air drag is an impulse, so it can be lumped: applied every 3rd substep over 3h.
 *  (Position constraints can't: velocity comes from the position change over one
 *  substep, so a correction sized for several would be counted as more velocity.) */
const AERO_EVERY = 3
/** Dry (Coulomb) friction at the hook (m/s² on the pins): unlike viscous friction it
 *  brings the swing to a stop in finite time. */
const HOOK_COULOMB = 1.5
/** Sleeping: when every particle is slower than this (m/s) for SLEEP_TIME (s) with
 *  nothing pushing, the cloth freezes until a grab, the wind or a move wakes it. */
const SLEEP_SPEED = 0.015
const SLEEP_TIME = 0.5
/** Below this speed (m/s), with nothing pushing, every velocity eases out (1/s) so the
 *  last slow creep fades smoothly into sleep instead of lingering. */
const EASE_SPEED = 0.06
const EASE_RATE = 2.5
/** Creases sharper than this (rad) are seams and hems: they keep their full rest angle. */
const SEAM_ANGLE = 1

function drapeRest(flat: Float32Array, seed: number): Float32Array {
  const out = new Float32Array(flat)
  for (let i = 0; i < out.length; i += 3) {
    const x = flat[i]
    const y = flat[i + 1]
    const hang = Math.min(1, Math.max(0, -y / 0.84))
    const folds = Math.sin(x * 11 + seed * 3.1) * 0.6 + Math.sin(x * 23 + seed * 7.7 + y * 3) * 0.4
    out[i] = x * (1 - HEM_GATHER * hang * hang)
    out[i + 2] = flat[i + 2] + folds * FOLD_DEPTH * hang
  }
  return out
}

/** Signed dihedral angle of quad (c, d | edge a→b) and, optionally, its gradient. */
function dihedral(p: Float32Array, c: number, d: number, a: number, b: number, grad?: Float64Array): number {
  const ax = p[a], ay = p[a + 1], az = p[a + 2]
  const ex = p[b] - ax, ey = p[b + 1] - ay, ez = p[b + 2] - az
  const cx = p[c] - ax, cy = p[c + 1] - ay, cz = p[c + 2] - az
  const dx = p[d] - ax, dy = p[d + 1] - ay, dz = p[d + 2] - az
  // n1 = e × (c − a), n2 = (d − a) × e
  const n1x = ey * cz - ez * cy, n1y = ez * cx - ex * cz, n1z = ex * cy - ey * cx
  const n2x = dy * ez - dz * ey, n2y = dz * ex - dx * ez, n2z = dx * ey - dy * ex
  const l1 = n1x * n1x + n1y * n1y + n1z * n1z
  const l2 = n2x * n2x + n2y * n2y + n2z * n2z
  const le = Math.sqrt(ex * ex + ey * ey + ez * ez)
  if (l1 < 1e-20 || l2 < 1e-20 || le < 1e-10) return NaN
  const cosT = n1x * n2x + n1y * n2y + n1z * n2z
  const kx = n1y * n2z - n1z * n2y, ky = n1z * n2x - n1x * n2z, kz = n1x * n2y - n1y * n2x
  const sinT = (kx * ex + ky * ey + kz * ez) / le
  const theta = Math.atan2(sinT, cosT)
  if (grad) {
    const m1 = 1 / l1, m2 = 1 / l2
    const ux = ex / le, uy = ey / le, uz = ez / le
    // projections onto the edge of (c − b), (d − b), (c − a), (d − a)
    const cA = cx * ux + cy * uy + cz * uz
    const dA = dx * ux + dy * uy + dz * uz
    const cB = cA - le
    const dB = dA - le
    // ∇θ (signs verified against finite differences)
    grad[0] = -le * m1 * n1x; grad[1] = -le * m1 * n1y; grad[2] = -le * m1 * n1z
    grad[3] = -le * m2 * n2x; grad[4] = -le * m2 * n2y; grad[5] = -le * m2 * n2z
    grad[6] = -(cB * m1 * n1x + dB * m2 * n2x)
    grad[7] = -(cB * m1 * n1y + dB * m2 * n2y)
    grad[8] = -(cB * m1 * n1z + dB * m2 * n2z)
    grad[9] = cA * m1 * n1x + dA * m2 * n2x
    grad[10] = cA * m1 * n1y + dA * m2 * n2y
    grad[11] = cA * m1 * n1z + dA * m2 * n2z
  }
  return theta
}

const wrapAngle = (a: number) => (a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a)

/** Quaternion product a·b, [x, y, z, w]. */
function qmul(a: ArrayLike<number>, b: ArrayLike<number>, out: number[]) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3]
  const bx = b[0], by = b[1], bz = b[2], bw = b[3]
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
  return out
}

function qToMatrix(q: ArrayLike<number>, R: Float32Array) {
  const x = q[0], y = q[1], z = q[2], w = q[3]
  R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w)
  R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w)
  R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y)
}

/** Min-heap Dijkstra from every pin over the edge graph: geodesic distance + nearest pin. */
function geodesicFromPins(n: number, edges: Uint32Array, lengths: Float32Array, pins: Uint32Array) {
  const deg = new Uint32Array(n + 1)
  for (let k = 0; k < edges.length; k++) deg[edges[k] + 1]++
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i]
  const adj = new Uint32Array(edges.length)
  const adjLen = new Float32Array(edges.length)
  const fill = deg.slice(0, n)
  for (let k = 0; k < lengths.length; k++) {
    const a = edges[2 * k], b = edges[2 * k + 1]
    adj[fill[a]] = b; adjLen[fill[a]++] = lengths[k]
    adj[fill[b]] = a; adjLen[fill[b]++] = lengths[k]
  }
  const dist = new Float32Array(n).fill(Infinity)
  const from = new Int32Array(n).fill(-1)
  const heap: [number, number][] = []
  const push = (d: number, i: number) => {
    heap.push([d, i])
    let c = heap.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (heap[p][0] <= heap[c][0]) break
      ;[heap[p], heap[c]] = [heap[c], heap[p]]
      c = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let c = 0
      for (;;) {
        const l = 2 * c + 1, r = l + 1
        let m = c
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === c) break
        ;[heap[m], heap[c]] = [heap[c], heap[m]]
        c = m
      }
    }
    return top
  }
  for (const p of pins) {
    dist[p] = 0
    from[p] = p
    push(0, p)
  }
  while (heap.length) {
    const [d, i] = pop()
    if (d > dist[i]) continue
    for (let k = deg[i]; k < deg[i + 1]; k++) {
      const j = adj[k]
      const nd = d + adjLen[k]
      if (nd < dist[j]) {
        dist[j] = nd
        from[j] = from[i]
        push(nd, j)
      }
    }
  }
  return { dist, from }
}

export class ClothSolver {
  readonly n: number
  pos: Float32Array
  prev: Float32Array
  vel: Float32Array
  invMass: Float32Array
  rest: Float32Array
  isPin: Uint8Array
  pins: Uint32Array
  edges: Uint32Array
  edgeLen: Float32Array
  /** Bending quads: wing c, wing d, edge a, edge b (particle indices). */
  quads: Uint32Array
  quadAngle: Float32Array
  thick: Uint32Array
  thickLen: Float32Array
  /** Long-range attachment: nearest pin per particle (−1 = none) and max distance. */
  lraPin: Int32Array
  lraLen: Float32Array
  tris: Uint32Array
  meanEdge: number
  drop: number
  substeps: number

  // hanger state: pivot glide, scripted yaw, physical swing (q = swing · yaw)
  pivot = [0, 0, 0]
  pivotV = [0, 0, 0]
  yaw = 0
  yawV = 0
  q = [0, 0, 0, 1]
  R = new Float32Array(9)

  grabSet: { i: number; w: number; ox: number; oy: number; oz: number }[] = []
  grabId = -1
  time = 0
  releaseT = 0
  releaseTotal = 1
  /** Frozen: nothing moved for a while and nothing is pushing. */
  asleep = false
  private stillT = 0
  private fastest = Infinity

  // self-collision pairs, rebuilt once per frame
  private pairs = new Uint32Array(0)
  private pairMin = new Float32Array(0)
  private pairCount = 0
  private hashStart: Int32Array
  private hashEntries: Int32Array
  private hashCells: Int32Array // cell xyz per particle, then its hash

  private scratch = new Float32Array(3)
  private grad = new Float64Array(12)
  private fit = new Float64Array(9)
  private tq = [0, 0, 0, 0]
  private tq2 = [0, 0, 0, 0]

  constructor(init: ClothInit) {
    this.n = init.particles.length / 3
    this.rest = init.draped ? new Float32Array(init.particles) : drapeRest(init.particles, init.seed)
    this.edges = init.edges
    this.thick = init.thickness
    this.pins = init.pins
    this.tris = init.triangles
    this.drop = init.drop
    this.substeps = init.substeps
    this.pos = new Float32Array(this.n * 3)
    this.prev = new Float32Array(this.n * 3)
    this.vel = new Float32Array(this.n * 3)
    this.isPin = new Uint8Array(this.n)
    for (const p of this.pins) this.isPin[p] = 1
    // the pins are the hanger's particles: they carry its mass on top of the fabric's
    const clothMass = MASS / this.n
    const pinMass = clothMass + HANGER_MASS / Math.max(1, this.pins.length)
    this.invMass = new Float32Array(this.n)
    for (let i = 0; i < this.n; i++) this.invMass[i] = 1 / (this.isPin[i] ? pinMass : clothMass)

    const r = this.rest
    const len = (list: Uint32Array) => {
      const out = new Float32Array(list.length / 2)
      for (let k = 0; k < out.length; k++) {
        const a = list[2 * k] * 3
        const b = list[2 * k + 1] * 3
        out[k] = Math.hypot(r[a] - r[b], r[a + 1] - r[b + 1], r[a + 2] - r[b + 2])
      }
      return out
    }
    this.edgeLen = len(this.edges)
    this.thickLen = len(this.thick)
    // stretch rests on the flat pattern where the drape had the fabric bunched up
    const pat = init.pattern
    if (pat) {
      for (let k = 0; k < this.edgeLen.length; k++) {
        const a = this.edges[2 * k], b = this.edges[2 * k + 1]
        const flat = Math.hypot(pat[2 * a] - pat[2 * b], pat[2 * a + 1] - pat[2 * b + 1])
        const draped = this.edgeLen[k]
        if (flat > draped && flat < draped * PATTERN_MAX_RATIO) this.edgeLen[k] = flat
      }
    }
    let sum = 0
    for (const l of this.edgeLen) sum += l
    this.meanEdge = sum / Math.max(1, this.edgeLen.length)

    this.quads = this.buildQuads()
    this.quadAngle = new Float32Array(this.quads.length / 4)
    for (let k = 0; k < this.quadAngle.length; k++) {
      const [c, d, a, b] = this.quads.subarray(4 * k, 4 * k + 4)
      const t = dihedral(r, c * 3, d * 3, a * 3, b * 3)
      this.quadAngle[k] = Number.isFinite(t) ? t : 0
    }

    const geo = geodesicFromPins(this.n, this.edges, this.edgeLen, this.pins)
    this.lraPin = geo.from
    this.lraLen = geo.dist.map((d) => d * LRA_SLACK)
    for (const p of this.pins) this.lraPin[p] = -1

    const table = 2 * this.n
    this.hashStart = new Int32Array(table + 1)
    this.hashEntries = new Int32Array(this.n)
    this.hashCells = new Int32Array(this.n * 4)

    const s = init.start
    this.pivot = [s.x, s.y, s.z]
    this.yaw = s.yaw
    this.q = [0, Math.sin(s.yaw / 2), 0, Math.cos(s.yaw / 2)]
    qToMatrix(this.q, this.R)
    for (let i = 0; i < this.n; i++) this.toWorld(i, this.pos)
    this.prev.set(this.pos)
  }

  /** One bending quad per interior edge (shared by exactly two triangles). */
  private buildQuads(): Uint32Array {
    const t = this.tris
    const key = (a: number, b: number) => Math.min(a, b) * 1_000_003 + Math.max(a, b)
    const seen = new Map<number, number[]>() // key → [a, b, c] from the first triangle
    const out: number[] = []
    for (let k = 0; k < t.length; k += 3) {
      for (let e = 0; e < 3; e++) {
        const a = t[k + e], b = t[k + ((e + 1) % 3)], c = t[k + ((e + 2) % 3)]
        const kk = key(a, b)
        const first = seen.get(kk)
        if (!first) seen.set(kk, [a, b, c])
        else if (first.length === 3) {
          if (first[2] !== c && !(this.isPin[first[0]] && this.isPin[first[1]] && this.isPin[first[2]] && this.isPin[c]))
            out.push(first[2], c, first[0], first[1])
          first.push(-1) // a third triangle on this edge: non-manifold, bend it once only
        }
      }
    }
    return new Uint32Array(out)
  }

  /** Rest position of particle i carried by the hanger, written into out. */
  private toWorld(i: number, out: Float32Array, at = i * 3) {
    const R = this.R
    const x = this.rest[i * 3]
    const y = this.rest[i * 3 + 1] - this.drop
    const z = this.rest[i * 3 + 2]
    out[at] = this.pivot[0] + R[0] * x + R[1] * y + R[2] * z
    out[at + 1] = this.pivot[1] + R[3] * x + R[4] * y + R[5] * z
    out[at + 2] = this.pivot[2] + R[6] * x + R[7] * y + R[8] * z
  }

  /** Teleport everything (used before the first frame of a slide-in). */
  settle(steps: number, input: ClothInput) {
    for (let k = 0; k < steps; k++) this.step({ ...input, dt: 1 / 60, wind: { ...input.wind, on: false }, grab: null })
  }

  /** The hook point glides to its target; the hook's swivel tracks the yaw target. */
  private stepHook(h: number, t: ClothTarget, cfg: ClothConfig) {
    const ax: number[] = [0, 0, 0]
    const tgt = [t.x, t.y, t.z]
    const pk = t.glide?.stiffness ?? cfg.glideStiffness
    const pc = 2 * Math.sqrt(pk) // critically damped glide
    const amax = t.glide?.maxAccel ?? cfg.glideMaxAccel
    for (let k = 0; k < 3; k++) ax[k] = pk * (tgt[k] - this.pivot[k]) - pc * this.pivotV[k]
    const am = Math.hypot(ax[0], ax[1], ax[2])
    if (am > amax) for (let k = 0; k < 3; k++) ax[k] *= amax / am
    for (let k = 0; k < 3; k++) {
      this.pivotV[k] += ax[k] * h
      this.pivot[k] += this.pivotV[k] * h
    }
    // a scripted move tracks its eased yaw path tightly (critically damped); otherwise the
    // softer, slightly bouncy flip spring
    const yk = t.calm ? pk : cfg.flipStiffness
    const yc = t.calm ? 2 * Math.sqrt(pk) : 2 * cfg.flipDamping * Math.sqrt(cfg.flipStiffness)
    const ay = yk * (t.yaw - this.yaw) - yc * this.yawV
    this.yawV += ay * h
    this.yaw += this.yawV * h
  }

  /**
   * Rigid hanger: best-fit rotation of the pins about the hook (shape matching, rotation
   * extracted as in Müller et al. 2016), keep its swing, replace its twist by the scripted
   * yaw, then put the pins back on the rigid hanger.
   */
  private projectHanger(h: number, calm: boolean) {
    const p = this.pos, r = this.rest, w = this.invMass
    const A = this.fit
    A.fill(0)
    for (const i of this.pins) {
      const m = 1 / w[i]
      const px = p[i * 3] - this.pivot[0], py = p[i * 3 + 1] - this.pivot[1], pz = p[i * 3 + 2] - this.pivot[2]
      const ox = r[i * 3], oy = r[i * 3 + 1] - this.drop, oz = r[i * 3 + 2]
      A[0] += m * px * ox; A[1] += m * px * oy; A[2] += m * px * oz
      A[3] += m * py * ox; A[4] += m * py * oy; A[5] += m * py * oz
      A[6] += m * pz * ox; A[7] += m * pz * oy; A[8] += m * pz * oz
    }
    const q = this.q
    const R = this.R
    for (let iter = 0; iter < 4; iter++) {
      qToMatrix(q, R)
      // ω = Σ r_j × a_j / |Σ r_j · a_j|  (columns of R and A)
      let wx = 0, wy = 0, wz = 0, dot = 0
      for (let c = 0; c < 3; c++) {
        const rx = R[c], ry = R[3 + c], rz = R[6 + c]
        const ax = A[c], ay = A[3 + c], az = A[6 + c]
        wx += ry * az - rz * ay
        wy += rz * ax - rx * az
        wz += rx * ay - ry * ax
        dot += rx * ax + ry * ay + rz * az
      }
      const s = 1 / (Math.abs(dot) + 1e-12)
      wx *= s; wy *= s; wz *= s
      const ang = Math.hypot(wx, wy, wz)
      if (ang < 1e-9) break
      const sh = Math.sin(ang / 2) / ang
      const dq = [wx * sh, wy * sh, wz * sh, Math.cos(ang / 2)]
      qmul(dq, q, this.tq)
      const nl = Math.hypot(this.tq[0], this.tq[1], this.tq[2], this.tq[3])
      for (let k = 0; k < 4; k++) q[k] = this.tq[k] / nl
    }
    // swing–twist about the vertical: q = swing · twist
    let tw = Math.hypot(q[1], q[3])
    const twist = tw < 1e-9 ? [0, 0, 0, 1] : [0, q[1] / tw, 0, q[3] / tw]
    const swing = qmul(q, [0, -twist[1], 0, twist[3]], this.tq)
    if (swing[3] < 0) for (let k = 0; k < 4; k++) swing[k] = -swing[k]
    const half = Math.acos(Math.min(1, swing[3]))
    let angle = Math.min(2 * half, SWING_MAX)
    if (calm) angle *= Math.exp(-CARRY_STRAIGHTEN * h)
    tw = Math.hypot(swing[0], swing[1], swing[2])
    if (tw > 1e-9) {
      const k = Math.sin(angle / 2) / tw
      swing[0] *= k; swing[1] *= k; swing[2] *= k
      swing[3] = Math.cos(angle / 2)
    }
    qmul(swing, [0, Math.sin(this.yaw / 2), 0, Math.cos(this.yaw / 2)], this.tq2)
    for (let k = 0; k < 4; k++) q[k] = this.tq2[k]
    qToMatrix(q, R)
    for (const i of this.pins) this.toWorld(i, p)
  }

  /** Rest drape hanging still (no swing) at a target pose, written into `out` (xyz per particle). */
  restAt(t: ClothTarget, out: Float32Array) {
    const c = Math.cos(t.yaw), sn = Math.sin(t.yaw), r = this.rest
    for (let i = 0; i < this.n; i++) {
      const j = i * 3
      const x = r[j], y = r[j + 1] - this.drop, z = r[j + 2]
      // R_y(yaw)
      out[j] = t.x + c * x + sn * z
      out[j + 1] = t.y + y
      out[j + 2] = t.z - sn * x + c * z
    }
  }

  /** Hanger transform for rendering: pivot + quaternion. */
  hangerPose(out: Float32Array, offset: number) {
    out[offset] = this.pivot[0]
    out[offset + 1] = this.pivot[1]
    out[offset + 2] = this.pivot[2]
    out[offset + 3] = this.q[0]
    out[offset + 4] = this.q[1]
    out[offset + 5] = this.q[2]
    out[offset + 6] = this.q[3]
  }

  private updateGrab(grab: ClothInput['grab'], radius: number, falloff: number, releaseTime: number) {
    if (!grab) {
      if (this.grabId >= 0) {
        this.releaseT = releaseTime
        this.releaseTotal = releaseTime
      }
      this.grabSet = []
      this.grabId = -1
      return
    }
    if (grab.id === this.grabId) return
    // new grab: take a soft patch around the picked particle
    this.grabId = grab.id
    const p = this.pos
    const c = grab.id * 3
    this.grabSet = []
    for (let i = 0; i < this.n; i++) {
      if (this.isPin[i]) continue
      const dx = p[i * 3] - p[c], dy = p[i * 3 + 1] - p[c + 1], dz = p[i * 3 + 2] - p[c + 2]
      const d = Math.hypot(dx, dy, dz)
      if (d < radius) this.grabSet.push({ i, w: (1 - d / radius) ** falloff, ox: dx, oy: dy, oz: dz })
    }
  }

  /** Stretch: separate compliances for tension and compression. */
  private solveStretch(tension: number, compression: number, h2: number) {
    const p = this.pos, w = this.invMass, list = this.edges, lengths = this.edgeLen
    const aT = tension / h2, aC = compression / h2
    for (let k = 0; k < lengths.length; k++) {
      const a = list[2 * k], b = list[2 * k + 1]
      const wa = w[a], wb = w[b]
      const ax = a * 3, bx = b * 3
      const dx = p[ax] - p[bx], dy = p[ax + 1] - p[bx + 1], dz = p[ax + 2] - p[bx + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d < 1e-9) continue
      const C = d - lengths[k]
      const s = -C / (wa + wb + (C < 0 ? aC : aT)) / d
      p[ax] += dx * s * wa; p[ax + 1] += dy * s * wa; p[ax + 2] += dz * s * wa
      p[bx] -= dx * s * wb; p[bx + 1] -= dy * s * wb; p[bx + 2] -= dz * s * wb
    }
  }

  private solveBending(compliance: number, keep: number, h2: number) {
    const p = this.pos, w = this.invMass, quads = this.quads, g = this.grad
    const alpha = compliance / h2
    for (let k = 0; k < this.quadAngle.length; k++) {
      const c = quads[4 * k], d = quads[4 * k + 1], a = quads[4 * k + 2], b = quads[4 * k + 3]
      const theta = dihedral(p, c * 3, d * 3, a * 3, b * 3, g)
      if (!Number.isFinite(theta)) continue
      const rest = this.quadAngle[k]
      const C = wrapAngle(theta - (Math.abs(rest) > SEAM_ANGLE ? rest : rest * keep))
      const wc = w[c], wd = w[d], wa = w[a], wb = w[b]
      const denom =
        wc * (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) +
        wd * (g[3] * g[3] + g[4] * g[4] + g[5] * g[5]) +
        wa * (g[6] * g[6] + g[7] * g[7] + g[8] * g[8]) +
        wb * (g[9] * g[9] + g[10] * g[10] + g[11] * g[11]) +
        alpha
      if (denom < 1e-12) continue
      const l = -C / denom
      let j = c * 3, s = l * wc
      p[j] += s * g[0]; p[j + 1] += s * g[1]; p[j + 2] += s * g[2]
      j = d * 3; s = l * wd
      p[j] += s * g[3]; p[j + 1] += s * g[4]; p[j + 2] += s * g[5]
      j = a * 3; s = l * wa
      p[j] += s * g[6]; p[j + 1] += s * g[7]; p[j + 2] += s * g[8]
      j = b * 3; s = l * wb
      p[j] += s * g[9]; p[j + 1] += s * g[10]; p[j + 2] += s * g[11]
    }
  }

  /** Volume: front↔back pairs never collapse below a fraction of their rest separation. */
  private solveVolume() {
    const p = this.pos, w = this.invMass, list = this.thick
    for (let k = 0; k < this.thickLen.length; k++) {
      const a = list[2 * k], b = list[2 * k + 1]
      const ax = a * 3, bx = b * 3
      const dx = p[ax] - p[bx], dy = p[ax + 1] - p[bx + 1], dz = p[ax + 2] - p[bx + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      const min = this.thickLen[k] * VOLUME_MIN
      if (d >= min || d < 1e-9) continue
      const wa = w[a], wb = w[b]
      const s = (min - d) / (wa + wb) / d
      p[ax] += dx * s * wa; p[ax + 1] += dy * s * wa; p[ax + 2] += dz * s * wa
      p[bx] -= dx * s * wb; p[bx + 1] -= dy * s * wb; p[bx + 2] -= dz * s * wb
    }
  }

  /** Long-range attachments: one-sided max distance to the nearest pin. */
  private solveAttachments() {
    const p = this.pos, pin = this.lraPin, max = this.lraLen
    for (let i = 0; i < this.n; i++) {
      const a = pin[i]
      if (a < 0) continue
      const j = i * 3, k = a * 3
      const dx = p[j] - p[k], dy = p[j + 1] - p[k + 1], dz = p[j + 2] - p[k + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d <= max[i]) continue
      const s = (max[i] - d) / d
      p[j] += dx * s; p[j + 1] += dy * s; p[j + 2] += dz * s
    }
  }

  private solveGrab(gx: number, gy: number, gz: number, compliance: number, h2: number) {
    const p = this.pos, w = this.invMass
    for (const q of this.grabSet) {
      if (q.w < 1e-4) continue
      const j = q.i * 3
      // the patch edge holds more loosely: compliance grows as the falloff weight drops
      const wi = w[q.i]
      const k = wi / (wi + compliance / (q.w * h2))
      p[j] += (gx + q.ox - p[j]) * k
      p[j + 1] += (gy + q.oy - p[j + 1]) * k
      p[j + 2] += (gz + q.oz - p[j + 2]) * k
    }
  }

  /** Spatial hash of the current positions → candidate self-collision pairs for this frame. */
  private buildPairs(thickness: number) {
    this.pairCount = 0
    if (thickness <= 0) return
    const p = this.pos, r = this.rest, n = this.n
    // query radius with a margin for this frame's motion; cells twice as wide
    const radius = thickness * 1.5
    const spacing = radius * 2
    const table = this.hashStart.length - 1
    const inv = 1 / spacing
    const hash = (xi: number, yi: number, zi: number) =>
      Math.abs((xi * 92837111) ^ (yi * 689287499) ^ (zi * 283923481)) % table
    const start = this.hashStart, entries = this.hashEntries, cells = this.hashCells
    start.fill(0)
    for (let i = 0; i < n; i++) {
      const j = i * 3
      cells[j] = Math.floor(p[j] * inv)
      cells[j + 1] = Math.floor(p[j + 1] * inv)
      cells[j + 2] = Math.floor(p[j + 2] * inv)
      start[(cells[n * 3 + i] = hash(cells[j], cells[j + 1], cells[j + 2]))]++
    }
    let acc = 0
    for (let k = 0; k < table; k++) {
      acc += start[k]
      start[k] = acc
    }
    start[table] = acc
    for (let i = 0; i < n; i++) entries[--start[cells[n * 3 + i]]] = i

    const q2 = radius * radius
    const t2 = thickness * thickness
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2]
      const cx = cells[i * 3], cy = cells[i * 3 + 1], cz = cells[i * 3 + 2]
      // cells are twice the query radius, so only the 2×2×2 block on the side of the cell
      // the particle sits in can hold neighbours (8 lookups instead of 27)
      const sx = x * inv - cx < 0.5 ? -1 : 0, sy = y * inv - cy < 0.5 ? -1 : 0, sz = z * inv - cz < 0.5 ? -1 : 0
      for (let ox = sx; ox <= sx + 1; ox++)
        for (let oy = sy; oy <= sy + 1; oy++)
          for (let oz = sz; oz <= sz + 1; oz++) {
            const hc = hash(cx + ox, cy + oy, cz + oz)
            for (let e = start[hc]; e < start[hc + 1]; e++) {
              const j = entries[e]
              if (j <= i || (this.isPin[i] && this.isPin[j])) continue
              const dx = p[j * 3] - x, dy = p[j * 3 + 1] - y, dz = p[j * 3 + 2] - z
              if (dx * dx + dy * dy + dz * dz > q2) continue
              const rx = r[j * 3] - r[i * 3], ry = r[j * 3 + 1] - r[i * 3 + 1], rz = r[j * 3 + 2] - r[i * 3 + 2]
              const rest2 = rx * rx + ry * ry + rz * rz
              // neighbours that start closer than the thickness may stay as close as they started
              const min = rest2 < t2 ? Math.sqrt(rest2) : thickness
              if (min < 1e-6) continue
              if (this.pairCount * 2 >= this.pairs.length) {
                const grown = new Uint32Array(Math.max(1024, this.pairs.length * 2))
                grown.set(this.pairs)
                this.pairs = grown
                const gm = new Float32Array(grown.length / 2)
                gm.set(this.pairMin)
                this.pairMin = gm
              }
              this.pairs[this.pairCount * 2] = i
              this.pairs[this.pairCount * 2 + 1] = j
              this.pairMin[this.pairCount++] = min
            }
          }
    }
  }

  private solveCollisions() {
    const p = this.pos, prev = this.prev, w = this.invMass, pairs = this.pairs
    for (let k = 0; k < this.pairCount; k++) {
      const a = pairs[2 * k], b = pairs[2 * k + 1]
      const ax = a * 3, bx = b * 3
      const dx = p[bx] - p[ax], dy = p[bx + 1] - p[ax + 1], dz = p[bx + 2] - p[ax + 2]
      const d2 = dx * dx + dy * dy + dz * dz
      const min = this.pairMin[k]
      if (d2 >= min * min || d2 < 1e-18) continue
      const d = Math.sqrt(d2)
      const wa = w[a], wb = w[b], ws = wa + wb
      const s = (min - d) / d / ws
      p[ax] -= dx * s * wa; p[ax + 1] -= dy * s * wa; p[ax + 2] -= dz * s * wa
      p[bx] += dx * s * wb; p[bx + 1] += dy * s * wb; p[bx + 2] += dz * s * wb
      // friction: pull both displacements toward their mass-weighted average
      for (let c = 0; c < 3; c++) {
        const va = p[ax + c] - prev[ax + c], vb = p[bx + c] - prev[bx + c]
        const avg = (va * wb + vb * wa) / ws
        p[ax + c] += (avg - va) * COLLISION_FRICTION
        p[bx + c] += (avg - vb) * COLLISION_FRICTION
      }
    }
  }

  /**
   * Damp only the deformation: each velocity is pulled toward the garment's rigid motion
   * (centre-of-mass velocity + angular velocity), so swinging and turning survive.
   */
  private dampDeformation(k: number) {
    if (k <= 0) return
    const p = this.pos, v = this.vel, w = this.invMass, n = this.n
    let M = 0, cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0
    for (let i = 0; i < n; i++) {
      const m = 1 / w[i], j = i * 3
      M += m
      cx += m * p[j]; cy += m * p[j + 1]; cz += m * p[j + 2]
      vx += m * v[j]; vy += m * v[j + 1]; vz += m * v[j + 2]
    }
    cx /= M; cy /= M; cz /= M; vx /= M; vy /= M; vz /= M
    let Lx = 0, Ly = 0, Lz = 0
    let Ixx = 0, Iyy = 0, Izz = 0, Ixy = 0, Ixz = 0, Iyz = 0
    for (let i = 0; i < n; i++) {
      const m = 1 / w[i], j = i * 3
      const rx = p[j] - cx, ry = p[j + 1] - cy, rz = p[j + 2] - cz
      const ux = v[j], uy = v[j + 1], uz = v[j + 2]
      Lx += m * (ry * uz - rz * uy); Ly += m * (rz * ux - rx * uz); Lz += m * (rx * uy - ry * ux)
      Ixx += m * (ry * ry + rz * rz); Iyy += m * (rx * rx + rz * rz); Izz += m * (rx * rx + ry * ry)
      Ixy -= m * rx * ry; Ixz -= m * rx * rz; Iyz -= m * ry * rz
    }
    // ω = I⁻¹ L (symmetric 3×3, adjugate inverse)
    const a00 = Iyy * Izz - Iyz * Iyz, a01 = Ixz * Iyz - Ixy * Izz, a02 = Ixy * Iyz - Ixz * Iyy
    const a11 = Ixx * Izz - Ixz * Ixz, a12 = Ixy * Ixz - Ixx * Iyz, a22 = Ixx * Iyy - Ixy * Ixy
    const det = Ixx * a00 + Ixy * a01 + Ixz * a02
    let ox = 0, oy = 0, oz = 0
    if (Math.abs(det) > 1e-18) {
      ox = (a00 * Lx + a01 * Ly + a02 * Lz) / det
      oy = (a01 * Lx + a11 * Ly + a12 * Lz) / det
      oz = (a02 * Lx + a12 * Ly + a22 * Lz) / det
    }
    for (let i = 0; i < n; i++) {
      const j = i * 3
      const rx = p[j] - cx, ry = p[j + 1] - cy, rz = p[j + 2] - cz
      const tx = vx + oy * rz - oz * ry
      const ty = vy + oz * rx - ox * rz
      const tz = vz + ox * ry - oy * rx
      v[j] += (tx - v[j]) * k
      v[j + 1] += (ty - v[j + 1]) * k
      v[j + 2] += (tz - v[j + 2]) * k
    }
  }

  private applyAero(h: number, wind: ClothInput['wind'], aero: number) {
    const p = this.pos, v = this.vel, w = this.invMass, t = this.tris
    for (let k = 0; k < t.length; k += 3) {
      const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2]
      const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2]
      let nx = e1y * e2z - e1z * e2y
      let ny = e1z * e2x - e1x * e2z
      let nz = e1x * e2y - e1y * e2x
      const area2 = Math.sqrt(nx * nx + ny * ny + nz * nz)
      if (area2 < 1e-12) continue
      nx /= area2; ny /= area2; nz /= area2
      let ax = 0, ay = 0, az = 0
      if (wind.on) {
        const cx = (p[a] + p[b] + p[c]) / 3 - wind.x
        const cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3 - wind.y
        const cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3 - wind.z
        const f = 1 - Math.sqrt(cx * cx + cy * cy + cz * cz) / wind.r
        if (f > 0) {
          ax += wind.vx * f * f
          ay += wind.vy * f * f
          az += wind.vz * f * f
        }
      }
      const rvx = (v[a] + v[b] + v[c]) / 3 - ax
      const rvy = (v[a + 1] + v[b + 1] + v[c + 1]) / 3 - ay
      const rvz = (v[a + 2] + v[b + 2] + v[c + 2]) / 3 - az
      const vn = rvx * nx + rvy * ny + rvz * nz
      // drag ∝ area · v_n · |v_n|, along the normal
      const F = -aero * (area2 * 0.5) * vn * Math.abs(vn) * h / 3
      const fx = F * nx, fy = F * ny, fz = F * nz
      let im = w[t[k]]
      v[a] += fx * im; v[a + 1] += fy * im; v[a + 2] += fz * im
      im = w[t[k + 1]]
      v[b] += fx * im; v[b + 1] += fy * im; v[b + 2] += fz * im
      im = w[t[k + 2]]
      v[c] += fx * im; v[c + 1] += fy * im; v[c + 2] += fz * im
    }
  }

  /** Something is (or may start) pushing the cloth: a grab, the wind, a hook move. */
  private disturbed(input: ClothInput) {
    const t = input.target, w = input.wind
    return (
      !!input.grab ||
      (w.on && Math.hypot(w.vx, w.vy, w.vz) > 0.02) ||
      Math.hypot(t.x - this.pivot[0], t.y - this.pivot[1], t.z - this.pivot[2]) > 5e-4 ||
      Math.abs(t.yaw - this.yaw) > 1e-3 ||
      Math.hypot(this.pivotV[0], this.pivotV[1], this.pivotV[2]) > 1e-3 ||
      Math.abs(this.yawV) > 1e-3
    )
  }

  /** Advance one frame. Returns false when the cloth is asleep (positions unchanged). */
  step(input: ClothInput): boolean {
    const pushed = this.disturbed(input)
    if (this.asleep) {
      if (!pushed) return false
      this.asleep = false
      this.stillT = 0
    }
    const frameDt = Math.min(input.dt, 1 / 30)
    const steps = this.substeps
    const h = frameDt / steps
    const h2 = h * h
    const p = this.pos, prev = this.prev, v = this.vel
    const cfg = input.cfg
    const calm = !!input.target.calm
    this.updateGrab(input.grab, cfg.grabRadius, cfg.grabFalloff, cfg.releaseTime)
    // the grab target can't drag fabric further than grabMaxPull from where it hangs
    let gx = 0, gy = 0, gz = 0
    if (input.grab) {
      gx = input.grab.x; gy = input.grab.y; gz = input.grab.z
      const r = this.scratch
      this.toWorld(this.grabId, r, 0)
      const dx = gx - r[0], dy = gy - r[1], dz = gz - r[2]
      const d = Math.hypot(dx, dy, dz)
      if (d > cfg.grabMaxPull) {
        const s = cfg.grabMaxPull / d
        gx = r[0] + dx * s; gy = r[1] + dy * s; gz = r[2] + dz * s
      }
    }
    this.buildPairs(cfg.selfCollision * this.meanEdge)
    // velocity-level damping is safe to apply once per frame
    const settle = this.releaseT > 0 ? cfg.releaseDamping * (this.releaseT / this.releaseTotal) : 0
    this.releaseT = Math.max(0, this.releaseT - frameDt)
    // while carried (put-back) the fabric is held calm too, so it lands hanging still
    const rate = cfg.damping + settle + (calm ? CARRY_DAMPING : 0)
    this.dampDeformation(1 - Math.exp(-rate * frameDt))
    if (!pushed && this.fastest < EASE_SPEED) {
      const k = Math.exp(-EASE_RATE * frameDt)
      for (let i = 0; i < v.length; i++) v[i] *= k
    }
    let fastest2 = 0

    for (let s = 0; s < steps; s++) {
      this.time += h
      this.stepHook(h, input.target, cfg)
      if (s % AERO_EVERY === 0) this.applyAero(h * Math.min(AERO_EVERY, steps - s), input.wind, cfg.aero)

      // hook friction, viscous + dry: the hanger's motion relative to the hook dies out
      const hook = Math.exp(-cfg.swingDamping * (calm ? CARRY_HOOK_FRICTION : 1) * h)
      const dry = HOOK_COULOMB * h
      for (const i of this.pins) {
        const j = i * 3
        let rx = (v[j] - this.pivotV[0]) * hook
        let ry = (v[j + 1] - this.pivotV[1]) * hook
        let rz = (v[j + 2] - this.pivotV[2]) * hook
        const rl = Math.sqrt(rx * rx + ry * ry + rz * rz)
        const k = rl > dry ? (rl - dry) / rl : 0
        rx *= k; ry *= k; rz *= k
        v[j] = this.pivotV[0] + rx
        v[j + 1] = this.pivotV[1] + ry
        v[j + 2] = this.pivotV[2] + rz
      }

      for (let i = 0; i < this.n; i++) {
        const j = i * 3
        prev[j] = p[j]
        prev[j + 1] = p[j + 1]
        prev[j + 2] = p[j + 2]
        v[j + 1] += GRAVITY * h
        p[j] += v[j] * h
        p[j + 1] += v[j + 1] * h
        p[j + 2] += v[j + 2] * h
      }

      this.solveStretch(cfg.stretchCompliance, cfg.compressionCompliance, h2)
      this.solveBending(cfg.bendCompliance, cfg.bendRestKeep, h2)
      this.solveVolume()
      if (input.grab) this.solveGrab(gx, gy, gz, cfg.grabCompliance, h2)
      this.solveCollisions()
      this.solveAttachments()
      this.projectHanger(h, calm)

      const inv = 1 / h
      const cap2 = cfg.maxSpeed * cfg.maxSpeed
      for (let i = 0; i < this.n; i++) {
        const j = i * 3
        let vx = (p[j] - prev[j]) * inv
        let vy = (p[j + 1] - prev[j + 1]) * inv
        let vz = (p[j + 2] - prev[j + 2]) * inv
        const s2 = vx * vx + vy * vy + vz * vz
        if (s2 > cap2) {
          const k = cfg.maxSpeed / Math.sqrt(s2)
          vx *= k; vy *= k; vz *= k
        }
        v[j] = vx
        v[j + 1] = vy
        v[j + 2] = vz
        if (s === steps - 1) fastest2 = Math.max(fastest2, vx * vx + vy * vy + vz * vz)
      }
    }

    this.fastest = Math.sqrt(fastest2)
    // sleep once everything has been still for a while and nothing is pushing
    if (!pushed && fastest2 < SLEEP_SPEED * SLEEP_SPEED) {
      this.stillT += frameDt
      if (this.stillT >= SLEEP_TIME) {
        this.asleep = true
        this.fastest = Infinity
        v.fill(0)
        this.prev.set(p)
      }
    } else this.stillT = 0
    return true
  }
}
