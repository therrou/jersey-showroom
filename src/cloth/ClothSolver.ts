// Position-based cloth (XPBD, "small steps": many substeps, one constraint pass each).
// Runs inside a worker. Pure math, no three.js.
//
// World frame matches the modal scene: the hanger pivot is where the hook meets an
// (invisible) rail; the garment hangs below it in -y.

export interface ClothInit {
  particles: Float32Array // rest positions in garment space (collar at origin)
  edges: Uint32Array
  bends: Uint32Array
  thickness: Uint32Array
  pins: Uint32Array
  triangles: Uint32Array // particle-index triangles (for aero drag)
  drop: number // pivot → collar
  seed: number // per-jersey drape variation
  substeps: number
  start: { x: number; y: number; z: number; yaw: number }
}

/** Live tuning (see src/config/physics.ts → modal). */
export interface ClothConfig {
  glideStiffness: number
  glideMaxAccel: number
  swingDamping: number
  flipStiffness: number
  flipDamping: number
  bendCompliance: number
  aero: number
}

export interface ClothTarget {
  x: number
  y: number
  z: number
  yaw: number
  /** Override the glide for this move (lift-off / put-back are quicker than a carousel step). */
  glide?: { stiffness: number; maxAccel: number }
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
const STRETCH_COMPLIANCE = 2e-8
const THICK_COMPLIANCE = 6e-4
const DAMPING = 0.35 // global velocity damping (1/s)
const GRAB_RADIUS = 0.07
// Rest-shape drape: the flat pattern gets soft vertical folds that deepen toward the
// hem (same profile as the rack shader), and the hem gathers in slightly. Bending
// constraints remember this shape, so folds re-form after the fabric is pulled.
const FOLD_DEPTH = 0.02
const HEM_GATHER = 0.04

// Hanger pendulum (pivot glide, yaw spring and swing damping come from ClothConfig)
const SWING_L = 0.45
const SWING_MAX = 0.6

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

export class ClothSolver {
  readonly n: number
  pos: Float32Array
  prev: Float32Array
  vel: Float32Array
  invMass: Float32Array
  rest: Float32Array
  edges: Uint32Array
  edgeLen: Float32Array
  bends: Uint32Array
  bendLen: Float32Array
  thick: Uint32Array
  thickLen: Float32Array
  pins: Uint32Array
  tris: Uint32Array
  drop: number
  substeps: number

  // hanger state
  pivot = [0, 0, 0]
  pivotV = [0, 0, 0]
  swingX = 0
  swingXV = 0
  swingZ = 0
  swingZV = 0
  yaw = 0
  yawV = 0
  // hanger rotation as a 3x3 (row-major), recomputed per substep
  R = new Float32Array(9)

  grabSet: { i: number; w: number; ox: number; oy: number; oz: number }[] = []
  grabId = -1
  time = 0

  constructor(init: ClothInit) {
    this.n = init.particles.length / 3
    this.rest = drapeRest(init.particles, init.seed)
    this.edges = init.edges
    this.bends = init.bends
    this.thick = init.thickness
    this.pins = init.pins
    this.tris = init.triangles
    this.drop = init.drop
    this.substeps = init.substeps
    this.pos = new Float32Array(this.n * 3)
    this.prev = new Float32Array(this.n * 3)
    this.vel = new Float32Array(this.n * 3)
    this.invMass = new Float32Array(this.n).fill(this.n / MASS)
    for (const p of this.pins) this.invMass[p] = 0

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
    this.bendLen = len(this.bends)
    this.thickLen = len(this.thick)

    const s = init.start
    this.pivot = [s.x, s.y, s.z]
    this.yaw = s.yaw
    this.updateRotation()
    for (let i = 0; i < this.n; i++) this.toWorld(i, this.pos)
    this.prev.set(this.pos)
  }

  private updateRotation() {
    // R = Rz(swingZ) · Rx(swingX) · Ry(yaw)
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw)
    const cx = Math.cos(this.swingX), sx = Math.sin(this.swingX)
    const cz = Math.cos(this.swingZ), sz = Math.sin(this.swingZ)
    // Rx·Ry
    const a = [cy, 0, sy, sx * sy, cx, -sx * cy, -cx * sy, sx, cx * cy]
    // Rz·(Rx·Ry)
    const R = this.R
    for (let c = 0; c < 3; c++) {
      R[c] = cz * a[c] - sz * a[3 + c]
      R[3 + c] = sz * a[c] + cz * a[3 + c]
      R[6 + c] = a[6 + c]
    }
  }

  /** Rest position of particle i carried by the hanger, written into out. */
  private toWorld(i: number, out: Float32Array) {
    const R = this.R
    const x = this.rest[i * 3]
    const y = this.rest[i * 3 + 1] - this.drop
    const z = this.rest[i * 3 + 2]
    out[i * 3] = this.pivot[0] + R[0] * x + R[1] * y + R[2] * z
    out[i * 3 + 1] = this.pivot[1] + R[3] * x + R[4] * y + R[5] * z
    out[i * 3 + 2] = this.pivot[2] + R[6] * x + R[7] * y + R[8] * z
  }

  /** Teleport everything (used before the first frame of a slide-in). */
  settle(steps: number, input: ClothInput) {
    for (let k = 0; k < steps; k++) this.step({ ...input, dt: 1 / 60, wind: { ...input.wind, on: false }, grab: null })
  }

  private stepHanger(h: number, t: ClothTarget, cfg: ClothConfig) {
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
    // pendulum driven by the pivot's acceleration: when the hook accelerates along +x
    // the hem lags toward -x, i.e. a negative rotation about z (and likewise for z/x)
    const g = -GRAVITY / SWING_L
    const azz = -g * Math.sin(this.swingZ) - cfg.swingDamping * this.swingZV - ax[0] / SWING_L
    const axx = -g * Math.sin(this.swingX) - cfg.swingDamping * this.swingXV + ax[2] / SWING_L
    this.swingZV += azz * h
    this.swingXV += axx * h
    this.swingZ = Math.max(-SWING_MAX, Math.min(SWING_MAX, this.swingZ + this.swingZV * h))
    this.swingX = Math.max(-SWING_MAX, Math.min(SWING_MAX, this.swingX + this.swingXV * h))

    const yc = 2 * cfg.flipDamping * Math.sqrt(cfg.flipStiffness)
    const ay = cfg.flipStiffness * (t.yaw - this.yaw) - yc * this.yawV
    this.yawV += ay * h
    this.yaw += this.yawV * h
    this.updateRotation()
  }

  /** Hanger transform for rendering: pivot + quaternion (from R). */
  hangerPose(out: Float32Array, offset: number) {
    const R = this.R
    out[offset] = this.pivot[0]
    out[offset + 1] = this.pivot[1]
    out[offset + 2] = this.pivot[2]
    // rotation matrix → quaternion
    const m00 = R[0], m01 = R[1], m02 = R[2], m10 = R[3], m11 = R[4], m12 = R[5], m20 = R[6], m21 = R[7], m22 = R[8]
    const tr = m00 + m11 + m22
    let qx, qy, qz, qw
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1)
      qw = 0.25 / s
      qx = (m21 - m12) * s
      qy = (m02 - m20) * s
      qz = (m10 - m01) * s
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
      qw = (m21 - m12) / s
      qx = 0.25 * s
      qy = (m01 + m10) / s
      qz = (m02 + m20) / s
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
      qw = (m02 - m20) / s
      qx = (m01 + m10) / s
      qy = 0.25 * s
      qz = (m12 + m21) / s
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
      qw = (m10 - m01) / s
      qx = (m02 + m20) / s
      qy = (m12 + m21) / s
      qz = 0.25 * s
    }
    out[offset + 3] = qx
    out[offset + 4] = qy
    out[offset + 5] = qz
    out[offset + 6] = qw
  }

  private updateGrab(grab: ClothInput['grab']) {
    if (!grab) {
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
      if (this.invMass[i] === 0) continue
      const dx = p[i * 3] - p[c], dy = p[i * 3 + 1] - p[c + 1], dz = p[i * 3 + 2] - p[c + 2]
      const d = Math.hypot(dx, dy, dz)
      if (d < GRAB_RADIUS) this.grabSet.push({ i, w: (1 - d / GRAB_RADIUS) ** 2, ox: dx, oy: dy, oz: dz })
    }
  }

  private solveDistance(list: Uint32Array, lengths: Float32Array, compliance: number, h2: number, unilateralMin = 0) {
    const p = this.pos
    const w = this.invMass
    const alpha = compliance / h2
    for (let k = 0; k < lengths.length; k++) {
      const a = list[2 * k], b = list[2 * k + 1]
      const wa = w[a], wb = w[b]
      const wsum = wa + wb
      if (wsum === 0) continue
      const ax = a * 3, bx = b * 3
      const dx = p[ax] - p[bx], dy = p[ax + 1] - p[bx + 1], dz = p[ax + 2] - p[bx + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d < 1e-9) continue
      let C = d - lengths[k]
      if (unilateralMin > 0) {
        // volume constraint: soft toward rest, hard above a minimum separation
        const min = lengths[k] * unilateralMin
        if (d < min) C = d - min
      }
      const lambda = -C / (wsum + (unilateralMin > 0 && d < lengths[k] * unilateralMin ? 0 : alpha))
      const s = lambda / d
      p[ax] += dx * s * wa
      p[ax + 1] += dy * s * wa
      p[ax + 2] += dz * s * wa
      p[bx] -= dx * s * wb
      p[bx + 1] -= dy * s * wb
      p[bx + 2] -= dz * s * wb
    }
  }

  private applyAero(h: number, wind: ClothInput['wind'], aero: number) {
    const p = this.pos, v = this.vel, w = this.invMass, t = this.tris
    // light ambient air so the cloth is never perfectly dead
    const bx = Math.sin(this.time * 0.7) * 0.05 + Math.sin(this.time * 1.9) * 0.03
    const bz = Math.cos(this.time * 0.5) * 0.06
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
      let ax = bx, ay = 0, az = bz
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
      for (const q of [a, b, c]) {
        const im = w[q / 3]
        if (im === 0) continue
        v[q] += F * nx * im
        v[q + 1] += F * ny * im
        v[q + 2] += F * nz * im
      }
    }
  }

  step(input: ClothInput) {
    const frameDt = Math.min(input.dt, 1 / 30)
    const steps = this.substeps
    const h = frameDt / steps
    const h2 = h * h
    const p = this.pos, prev = this.prev, v = this.vel, w = this.invMass
    this.updateGrab(input.grab)
    const damp = Math.max(0, 1 - DAMPING * h)

    for (let s = 0; s < steps; s++) {
      this.time += h
      this.stepHanger(h, input.target, input.cfg)
      this.applyAero(h, input.wind, input.cfg.aero)

      for (let i = 0; i < this.n; i++) {
        const j = i * 3
        prev[j] = p[j]
        prev[j + 1] = p[j + 1]
        prev[j + 2] = p[j + 2]
        if (w[i] === 0) {
          this.toWorld(i, p)
          continue
        }
        v[j] *= damp
        v[j + 1] = v[j + 1] * damp + GRAVITY * h
        v[j + 2] *= damp
        p[j] += v[j] * h
        p[j + 1] += v[j + 1] * h
        p[j + 2] += v[j + 2] * h
      }

      if (input.grab) {
        const g = input.grab
        for (const q of this.grabSet) {
          const j = q.i * 3
          const k = 0.6 * q.w
          p[j] += (g.x + q.ox - p[j]) * k
          p[j + 1] += (g.y + q.oy - p[j + 1]) * k
          p[j + 2] += (g.z + q.oz - p[j + 2]) * k
        }
      }

      this.solveDistance(this.edges, this.edgeLen, STRETCH_COMPLIANCE, h2)
      this.solveDistance(this.bends, this.bendLen, input.cfg.bendCompliance, h2)
      this.solveDistance(this.thick, this.thickLen, THICK_COMPLIANCE, h2, 0.25)

      const inv = 1 / h
      for (let i = 0; i < this.n; i++) {
        if (w[i] === 0) continue
        const j = i * 3
        v[j] = (p[j] - prev[j]) * inv
        v[j + 1] = (p[j + 1] - prev[j + 1]) * inv
        v[j + 2] = (p[j + 2] - prev[j + 2]) * inv
      }
    }
  }
}
