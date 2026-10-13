// Cloth on Rapier's soft bodies (rapier 0.36 / @dimforge/rapier3d-compat 0.21).
// Runs inside the worker, a drop-in for ClothSolver (same ClothSim surface).
//
// What Rapier simulates:
//   - the cage as one soft body: structural edges + signed dihedral bending (resting on the
//     drape) + soft front↔back springs that hold the tube open (Rapier's self-contacts
//     cost 100+ ms a step at this cage size), solved with the world's substepped solver
//   - the hanger: a dynamic rigid body hanging from a kinematic hook. The joint holds the
//     hook point and locks the twist (the yaw is scripted) but leaves both swing axes free,
//     so the cloth's mass swings it. The pins are particles attached to the hanger body.
//   - grab-and-pull: the patch core is pinned and moved as kinematic particles, so the pull
//     acts inside every substep (a once-a-frame push gets spread over the whole jersey)
// What stays ours:
//   - per-triangle quadratic air drag + the pointer's wind field (particle impulses)
//   - long-range attachments after each step (Kim et al. 2012): with few solver
//     iterations the fabric would otherwise sag past its length
//   - the hook glide / yaw spring, sleeping, the put-back calm
import RAPIER from '@dimforge/rapier3d-compat'
import { geodesicFromPins, type ClothConfig, type ClothInit, type ClothInput, type ClothTarget } from './ClothSolver'
import { physics } from '../config/physics'

const GRAVITY = -9.81
const MASS = 0.42 // kg, a replica jersey
const HANGER_MASS = 0.15
/** Hanger principal inertia (kg·m²): a 0.4 m wide bar, a little deep. */
const HANGER_INERTIA = { x: 0.002, y: 0.004, z: 0.0045 }
const CARRY_DAMPING = 5
const CARRY_HOOK_FRICTION = 6
const SLEEP_SPEED = 0.015
const SLEEP_TIME = 0.5
const EASE_SPEED = 0.06
const EASE_RATE = 2.5
/** Long-range attachments allow this much slack over the geodesic rest distance. */
const LRA_SLACK = 1.03
/** Patch particles at least this heavily weighted are held by the pointer; the rest follow. */
const GRAB_CORE = 0.3

let ready: Promise<void> | null = null
/** Loads the WASM once per worker. */
export const initRapier = () => (ready ??= RAPIER.init())

/** Dihedral quadruplets (shared edge a, b, then wings c, d) for every interior edge. */
function dihedrals(tris: Uint32Array, isPin: Uint8Array): Uint32Array {
  const key = (a: number, b: number) => Math.min(a, b) * 1_000_003 + Math.max(a, b)
  const seen = new Map<number, number[]>()
  const out: number[] = []
  for (let k = 0; k < tris.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tris[k + e], b = tris[k + ((e + 1) % 3)], c = tris[k + ((e + 2) % 3)]
      const kk = key(a, b)
      const first = seen.get(kk)
      if (!first) seen.set(kk, [a, b, c])
      else if (first.length === 3) {
        if (first[2] !== c && !(isPin[first[0]] && isPin[first[1]] && isPin[first[2]] && isPin[c]))
          out.push(first[0], first[1], first[2], c)
        first.push(-1) // non-manifold edge: bend it once only
      }
    }
  }
  return new Uint32Array(out)
}

export class RapierClothSolver {
  readonly n: number
  pos: Float32Array
  asleep = false
  yaw = 0

  private rest: Float32Array
  private drop: number
  private tris: Uint32Array
  private isPin: Uint8Array
  private world: RAPIER.World
  private soft: RAPIER.SoftBody
  private hook: RAPIER.RigidBody
  private hanger: RAPIER.RigidBody
  private pivot = [0, 0, 0]
  private pivotV = [0, 0, 0]
  private yawV = 0
  private stillT = 0
  private fastest = Infinity
  private meanEdge: number
  /** Last material knobs pushed to the soft body (re-sent only when ?tune changes them). */
  private matKey = ''
  private grabId = -1
  private grabCore: { i: number; ox: number; oy: number; oz: number }[] = []
  private held: Uint8Array
  /** The eased point the held patch follows, and its velocity (carried into a fling). */
  private grabAt = [0, 0, 0]
  private grabVel = [0, 0, 0]
  private lraPin: Int32Array
  private lraLen: Float32Array
  private dv: Float32Array

  constructor(init: ClothInit, cfg: ClothConfig) {
    this.n = init.particles.length / 3
    this.rest = new Float32Array(init.particles)
    this.drop = init.drop
    this.tris = init.triangles
    this.pos = new Float32Array(this.n * 3)
    this.dv = new Float32Array(this.n * 3)
    this.isPin = new Uint8Array(this.n)
    for (const p of init.pins) this.isPin[p] = 1

    const s = init.start
    this.pivot = [s.x, s.y, s.z]
    this.yaw = s.yaw
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw)
    const r = this.rest
    for (let i = 0; i < this.n; i++) {
      const j = i * 3
      const x = r[j], y = r[j + 1] - this.drop, z = r[j + 2]
      this.pos[j] = s.x + c * x + sn * z
      this.pos[j + 1] = s.y + y
      this.pos[j + 2] = s.z - sn * x + c * z
    }
    let sum = 0
    const e = init.edges
    for (let k = 0; k < e.length; k += 2) {
      const a = e[k] * 3, b = e[k + 1] * 3
      sum += Math.hypot(r[a] - r[b], r[a + 1] - r[b + 1], r[a + 2] - r[b + 2])
    }
    this.meanEdge = sum / Math.max(1, e.length / 2)
    const lengths = new Float32Array(e.length / 2)
    for (let k = 0; k < lengths.length; k++) {
      const a = e[2 * k] * 3, b = e[2 * k + 1] * 3
      lengths[k] = Math.hypot(r[a] - r[b], r[a + 1] - r[b + 1], r[a + 2] - r[b + 2])
    }
    const geo = geodesicFromPins(this.n, e, lengths, init.pins)
    this.lraPin = geo.from
    this.lraLen = geo.dist.map((d) => d * LRA_SLACK)
    for (const p of init.pins) this.lraPin[p] = -1
    this.held = new Uint8Array(this.n)

    const rc = physics.rapierCloth
    const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 })
    world.integrationParameters.dt = 1 / 60
    world.integrationParameters.numSolverIterations = rc.substeps
    this.world = world

    const rot = { x: 0, y: Math.sin(s.yaw / 2), z: 0, w: Math.cos(s.yaw / 2) }
    this.hook = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(s.x, s.y, s.z).setRotation(rot),
    )
    this.hanger = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(s.x, s.y, s.z)
        .setRotation(rot)
        .setAdditionalMassProperties(HANGER_MASS, { x: 0, y: -0.02, z: 0 }, HANGER_INERTIA, { x: 0, y: 0, z: 0, w: 1 })
        .setCanSleep(false),
    )
    // joint x axis = up: lock translation + twist about it, both swing axes stay free
    const L = RAPIER.JointAxesMask
    world.createImpulseJoint(
      RAPIER.JointData.generic({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, L.LinX | L.LinY | L.LinZ | L.AngX),
      this.hook,
      this.hanger,
      true,
    )

    const masses = new Float32Array(this.n).fill(MASS / this.n)
    // front↔back "thickness" links as soft springs after the structural edges: they hold
    // the tube open where self-contacts would (those cost ~100+ ms a step at this cage size)
    const nEdges = init.edges.length / 2, nThick = init.thickness.length / 2
    const all = new Uint32Array(init.edges.length + init.thickness.length)
    all.set(init.edges)
    all.set(init.thickness, init.edges.length)
    const thickIdx = Array.from({ length: nThick }, (_, k) => nEdges + k)
    const desc = new RAPIER.SoftBodyDesc(this.pos)
      .setEdges(all)
      .setEdgeSoftness(thickIdx, thickIdx.map(() => ({ naturalFrequency: rc.thicknessHz, dampingRatio: 1 })))
      .setDihedrals(dihedrals(init.triangles, this.isPin))
      .setSurface(init.triangles)
      .setMasses(masses)
      .setMaterial(this.material(rc))
      .setSurfaceCollider(RAPIER.ColliderDesc.ball(0.01).setFriction(0.1))
      .setSelfContacts(rc.selfContacts)
      .setOriented(false)
      .setParticleRadius(Math.max(1e-3, 0.5 * cfg.selfCollision * this.meanEdge))
      .setLinearDamping(rc.linearDamping)
      .setCanSleep(false) // sleeping is ours (below), so a sleeping jersey costs nothing
      .setAdditionalPgsIterations(rc.pgsIterations)
    this.soft = world.createSoftBody(desc)
    for (const p of init.pins) this.soft.attachParticle(p, this.hanger)
    this.matKey = JSON.stringify(rc)
  }

  private material(rc: typeof physics.rapierCloth) {
    const mat = new RAPIER.SoftBodyMaterial()
    mat.edgeSoftness = { naturalFrequency: rc.stretchHz, dampingRatio: rc.stretchDamping }
    mat.bendSoftness = { naturalFrequency: rc.bendHz, dampingRatio: rc.bendDamping }
    return mat
  }

  settle(steps: number, input: ClothInput) {
    for (let k = 0; k < steps; k++) this.step({ ...input, dt: 1 / 60, wind: { ...input.wind, on: false }, grab: null })
  }

  /** Same hook as ClothSolver: critically damped glide, yaw spring (or tight when carried). */
  private stepHook(h: number, t: ClothTarget, cfg: ClothConfig) {
    const tgt = [t.x, t.y, t.z]
    const pk = t.glide?.stiffness ?? cfg.glideStiffness
    const pc = 2 * Math.sqrt(pk)
    const amax = t.glide?.maxAccel ?? cfg.glideMaxAccel
    const ax = [0, 0, 0]
    for (let k = 0; k < 3; k++) ax[k] = pk * (tgt[k] - this.pivot[k]) - pc * this.pivotV[k]
    const am = Math.hypot(ax[0], ax[1], ax[2])
    if (am > amax) for (let k = 0; k < 3; k++) ax[k] *= amax / am
    for (let k = 0; k < 3; k++) {
      this.pivotV[k] += ax[k] * h
      this.pivot[k] += this.pivotV[k] * h
    }
    const yk = t.calm ? pk : cfg.flipStiffness
    const yc = t.calm ? 2 * Math.sqrt(pk) : 2 * cfg.flipDamping * Math.sqrt(cfg.flipStiffness)
    this.yawV += (yk * (t.yaw - this.yaw) - yc * this.yawV) * h
    this.yaw += this.yawV * h
  }

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

  /** Per-triangle quadratic drag against the air (moving with the wind field), as Δv. */
  private aero(h: number, vel: Float32Array, wind: ClothInput['wind'], aero: number) {
    const p = this.pos, t = this.tris, dv = this.dv
    const im = this.n / MASS // uniform particle mass
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
          ax = wind.vx * f * f
          ay = wind.vy * f * f
          az = wind.vz * f * f
        }
      }
      const vn =
        ((vel[a] + vel[b] + vel[c]) / 3 - ax) * nx +
        ((vel[a + 1] + vel[b + 1] + vel[c + 1]) / 3 - ay) * ny +
        ((vel[a + 2] + vel[b + 2] + vel[c + 2]) / 3 - az) * nz
      const F = (-aero * (area2 * 0.5) * vn * Math.abs(vn) * h * im) / 3
      for (const j of [a, b, c]) {
        dv[j] += F * nx
        dv[j + 1] += F * ny
        dv[j + 2] += F * nz
      }
    }
  }

  private release() {
    const v = { x: this.grabVel[0], y: this.grabVel[1], z: this.grabVel[2] }
    for (const { i } of this.grabCore) {
      this.soft.setParticlePinned(i, false)
      this.soft.setParticleVelocity(i, v) // keep the fling
      this.held[i] = 0
    }
    this.grabCore = []
    this.grabId = -1
  }

  private updateGrab(grab: ClothInput['grab'], radius: number, falloff: number) {
    if (!grab) {
      if (this.grabId >= 0) this.release()
      return
    }
    if (grab.id === this.grabId) return
    if (this.grabId >= 0) this.release()
    this.grabId = grab.id
    const p = this.pos, c = grab.id * 3
    this.grabAt = [p[c], p[c + 1], p[c + 2]]
    this.grabVel = [0, 0, 0]
    for (let i = 0; i < this.n; i++) {
      if (this.isPin[i]) continue
      const dx = p[i * 3] - p[c], dy = p[i * 3 + 1] - p[c + 1], dz = p[i * 3 + 2] - p[c + 2]
      const d = Math.hypot(dx, dy, dz)
      if (d < radius && (1 - d / radius) ** falloff >= GRAB_CORE) {
        this.grabCore.push({ i, ox: dx, oy: dy, oz: dz })
        this.soft.setParticlePinned(i, true)
        this.held[i] = 1
      }
    }
  }

  /** The held patch follows the pointer (eased: a looser grip lags more), as kinematic targets. */
  private grab(h: number, input: ClothInput) {
    const g = input.grab!
    const cfg = input.cfg
    // never drag the fabric further than grabMaxPull from where it hangs on the hanger
    const tr = this.hanger.translation(), q = this.hanger.rotation()
    const r = this.rest, gi = this.grabId * 3
    const lx = r[gi], ly = r[gi + 1] - this.drop, lz = r[gi + 2]
    // rotate (lx, ly, lz) by q
    const tx = 2 * (q.y * lz - q.z * ly), ty = 2 * (q.z * lx - q.x * lz), tz = 2 * (q.x * ly - q.y * lx)
    const hx = tr.x + lx + q.w * tx + (q.y * tz - q.z * ty)
    const hy = tr.y + ly + q.w * ty + (q.z * tx - q.x * tz)
    const hz = tr.z + lz + q.w * tz + (q.x * ty - q.y * tx)
    let gx = g.x, gy = g.y, gz = g.z
    const d = Math.hypot(gx - hx, gy - hy, gz - hz)
    if (d > cfg.grabMaxPull) {
      const s = cfg.grabMaxPull / d
      gx = hx + (gx - hx) * s; gy = hy + (gy - hy) * s; gz = hz + (gz - hz) * s
    }
    const tau = Math.min(0.3, Math.max(0.01, physics.rapierCloth.grabTime * (cfg.grabCompliance / 0.05)))
    const k = 1 - Math.exp(-h / tau)
    const a = this.grabAt, gt = [gx, gy, gz]
    for (let c = 0; c < 3; c++) {
      const step = (gt[c] - a[c]) * k
      a[c] += step
      this.grabVel[c] = step / h
    }
    const t = { x: 0, y: 0, z: 0 }
    for (const { i, ox, oy, oz } of this.grabCore) {
      t.x = a[0] + ox; t.y = a[1] + oy; t.z = a[2] + oz
      this.soft.setParticleKinematicTarget(i, t)
    }
  }

  /** Advance one frame. Returns false when the cloth is asleep (positions unchanged). */
  step(input: ClothInput): boolean {
    const pushed = this.disturbed(input)
    if (this.asleep) {
      if (!pushed) return false
      this.asleep = false
      this.stillT = 0
    }
    const h = Math.min(input.dt, 1 / 30)
    const cfg = input.cfg
    const rc = physics.rapierCloth
    const calm = !!input.target.calm
    const world = this.world, soft = this.soft

    // live tuning: rebuild the material only when a knob changed (linearDamping and
    // selfContacts are fixed at creation)
    const key = JSON.stringify(rc)
    if (key !== this.matKey) {
      this.matKey = key
      soft.setMaterial(this.material(rc))
      soft.setAdditionalPgsIterations(rc.pgsIterations)
      world.integrationParameters.numSolverIterations = rc.substeps
    }

    // the hook glides; Rapier moves the kinematic body there over this step
    this.stepHook(h, input.target, cfg)
    this.hook.setNextKinematicTranslation({ x: this.pivot[0], y: this.pivot[1], z: this.pivot[2] })
    this.hook.setNextKinematicRotation({ x: 0, y: Math.sin(this.yaw / 2), z: 0, w: Math.cos(this.yaw / 2) })
    this.hanger.setAngularDamping(cfg.swingDamping * (calm ? CARRY_HOOK_FRICTION : 1))

    // our forces, as one batch of per-particle impulses
    const vel = soft.particleVelocities()
    const dv = this.dv
    dv.fill(0)
    // extra damping on top of the body's own: calm while carried, and the ease-out of the
    // last slow creep into sleep
    let extra = calm ? CARRY_DAMPING : 0
    if (!pushed && this.fastest < EASE_SPEED) extra += EASE_RATE
    if (extra > 0) {
      const k = -(1 - Math.exp(-extra * h))
      for (let j = 0; j < dv.length; j++) dv[j] = vel[j] * k
    }
    this.aero(h, vel, input.wind, cfg.aero)
    this.updateGrab(input.grab, cfg.grabRadius, cfg.grabFalloff)
    if (input.grab && this.grabCore.length) this.grab(h, input)
    const m = MASS / this.n
    const imp = { x: 0, y: 0, z: 0 }
    for (let i = 0; i < this.n; i++) {
      const j = i * 3
      if (this.isPin[i] || this.held[i] || (dv[j] === 0 && dv[j + 1] === 0 && dv[j + 2] === 0)) continue
      imp.x = dv[j] * m; imp.y = dv[j + 1] * m; imp.z = dv[j + 2] * m
      soft.applyParticleImpulse(i, imp, false)
    }

    world.timestep = h
    world.step()
    const p = this.pos
    p.set(soft.particlePositions())

    // long-range attachments, speed cap (safety net) + sleep bookkeeping
    const v = soft.particleVelocities()
    const cap2 = cfg.maxSpeed * cfg.maxSpeed
    const pt = { x: 0, y: 0, z: 0 }, vt = { x: 0, y: 0, z: 0 }
    let fastest2 = 0
    for (let i = 0; i < this.n; i++) {
      const j = i * 3
      let vx = v[j], vy = v[j + 1], vz = v[j + 2]
      let touched = false
      const pin = this.lraPin[i]
      if (pin >= 0 && !this.held[i]) {
        const a = pin * 3
        const dx = p[j] - p[a], dy = p[j + 1] - p[a + 1], dz = p[j + 2] - p[a + 2]
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        const max = this.lraLen[i]
        if (d > max) {
          const ux = dx / d, uy = dy / d, uz = dz / d
          p[j] = p[a] + ux * max; p[j + 1] = p[a + 1] + uy * max; p[j + 2] = p[a + 2] + uz * max
          pt.x = p[j]; pt.y = p[j + 1]; pt.z = p[j + 2]
          soft.setParticlePosition(i, pt)
          // and no further outward drift
          const out = vx * ux + vy * uy + vz * uz
          if (out > 0) { vx -= out * ux; vy -= out * uy; vz -= out * uz }
          touched = true
        }
      }
      const s2 = vx * vx + vy * vy + vz * vz
      if (s2 > cap2) {
        const k = cfg.maxSpeed / Math.sqrt(s2)
        vx *= k; vy *= k; vz *= k
        touched = true
      }
      if (touched && !this.held[i]) {
        vt.x = vx; vt.y = vy; vt.z = vz
        soft.setParticleVelocity(i, vt)
      }
      if (s2 > fastest2) fastest2 = s2
    }
    this.fastest = Math.sqrt(fastest2)
    if (!pushed && fastest2 < SLEEP_SPEED * SLEEP_SPEED) {
      this.stillT += h
      if (this.stillT >= SLEEP_TIME) {
        this.asleep = true
        this.fastest = Infinity
      }
    } else this.stillT = 0
    return true
  }

  /** Rest drape hanging still at a target pose (ClothSolver.restAt). */
  restAt(t: ClothTarget, out: Float32Array) {
    const c = Math.cos(t.yaw), sn = Math.sin(t.yaw), r = this.rest
    for (let i = 0; i < this.n; i++) {
      const j = i * 3
      const x = r[j], y = r[j + 1] - this.drop, z = r[j + 2]
      out[j] = t.x + c * x + sn * z
      out[j + 1] = t.y + y
      out[j + 2] = t.z - sn * x + c * z
    }
  }

  /** Hanger transform for rendering: hook point + the hanger body's rotation. */
  hangerPose(out: Float32Array, offset: number) {
    const q = this.hanger.rotation()
    out[offset] = this.pivot[0]
    out[offset + 1] = this.pivot[1]
    out[offset + 2] = this.pivot[2]
    out[offset + 3] = q.x
    out[offset + 4] = q.y
    out[offset + 5] = q.z
    out[offset + 6] = q.w
  }

  free() {
    this.world.free()
  }
}
