/// <reference lib="webworker" />
import { ClothSolver, type ClothConfig, type ClothInit, type ClothInput, type ClothTarget } from './ClothSolver'
import { RapierClothSolver, initRapier } from './RapierClothSolver'
import { physics, type ClothSolverKind } from '../config/physics'

export type WorkerIn =
  | {
      type: 'init'
      init: ClothInit
      cfg: ClothConfig
      settleSteps: number
      solver: ClothSolverKind
      /** The main thread's live config (the worker has its own copy of the module). */
      rapierCloth: typeof physics.rapierCloth
    }
  | { type: 'step'; input: ClothInput; buffer: Float32Array; rapierCloth?: typeof physics.rapierCloth }

/** `frame`: new positions + hanger pose. `idle`: nothing moved (asleep); the buffer comes back unused. */
export type WorkerOut =
  | { type: 'frame'; positions: Float32Array; pose: Float32Array; ms: number }
  | { type: 'idle'; buffer: Float32Array }

// Fixed timestep ("fix your timestep"): the solver always advances in 1/60 s steps,
// whatever the display rate, and what's shown is interpolated between the last two
// steps. On a 120 Hz display that halves the work and keeps the motion identical.
const FIXED = 1 / 60
const MAX_STEPS = 2 // per message; any further backlog is dropped (slow motion beats a spiral)

/** What the worker needs from a solver: ClothSolver (custom XPBD) or RapierClothSolver. */
type ClothSim = Pick<ClothSolver, 'n' | 'pos' | 'asleep' | 'yaw' | 'settle' | 'step' | 'restAt' | 'hangerPose'>

let solver: ClothSim | null = null
let acc = 0
/** Smoothed solver time per step (ms), reported with each frame (?perf logs it). */
let stepMs = 0
let prevPos = new Float32Array(0)
const prevPose = new Float32Array(8)
const curPose = new Float32Array(8)
/** The last frame posted already shows the sleeping cloth exactly. */
let shownAsleep = false
let shownBlend = 0
let restBuf = new Float32Array(0)

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data
  if (msg.type === 'init') {
    Object.assign(physics.rapierCloth, msg.rapierCloth)
    if (msg.solver === 'rapier') {
      // the main thread sends no step before the first frame, so nothing arrives meanwhile
      await initRapier()
      solver = new RapierClothSolver(msg.init, msg.cfg)
    } else solver = new ClothSolver(msg.init)
    // optional pre-settle at the spawn pose (the modal starts from the rest drape: 0 steps)
    const still = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, on: false }
    solver.settle(msg.settleSteps, { dt: FIXED, cfg: msg.cfg, target: msg.init.start, wind: still, grab: null })
    prevPos = new Float32Array(solver.pos)
    restBuf = new Float32Array(solver.n * 3)
    pose(solver, prevPose)
    acc = 0
    shownAsleep = false
    post(new Float32Array(solver.n * 3), 1, msg.init.start)
    return
  }
  if (!solver) return reply({ type: 'idle', buffer: msg.buffer }, msg.buffer)
  if (msg.rapierCloth) Object.assign(physics.rapierCloth, msg.rapierCloth)
  const s = solver
  acc += Math.min(msg.input.dt, 0.1)
  let steps = 0
  while (acc >= FIXED && steps < MAX_STEPS) {
    prevPos.set(s.pos)
    pose(s, prevPose)
    const t0 = performance.now()
    if (s.step({ ...msg.input, dt: FIXED })) stepMs += (performance.now() - t0 - stepMs) * 0.1
    acc -= FIXED
    steps++
  }
  if (acc >= FIXED) acc %= FIXED
  const blend = msg.input.target.rest ?? 0
  if (s.asleep) {
    // nothing moves: show the resting pose once, then stay quiet
    if (shownAsleep && blend === shownBlend) return reply({ type: 'idle', buffer: msg.buffer }, msg.buffer)
    prevPos.set(s.pos)
    pose(s, prevPose)
    shownAsleep = true
  } else shownAsleep = false
  post(msg.buffer.length === s.n * 3 ? msg.buffer : new Float32Array(s.n * 3), acc / FIXED, msg.input.target)
}

function pose(s: ClothSim, out: Float32Array) {
  s.hangerPose(out, 0)
  out[7] = s.yaw // unwrapped, so a put-back can continue from it
}

/**
 * Post positions and pose interpolated between the previous and the current step, then
 * blended toward the still rest drape at the target by `target.rest`.
 */
function post(buffer: Float32Array, alpha: number, target: ClothTarget) {
  const s = solver!
  const cur = s.pos
  const a = alpha, b = 1 - alpha
  for (let i = 0; i < buffer.length; i++) buffer[i] = prevPos[i] * b + cur[i] * a
  pose(s, curPose)
  const out = new Float32Array(8)
  for (let k = 0; k < 3; k++) out[k] = prevPose[k] * b + curPose[k] * a
  // quaternion nlerp along the shorter arc
  const dot = prevPose[3] * curPose[3] + prevPose[4] * curPose[4] + prevPose[5] * curPose[5] + prevPose[6] * curPose[6]
  const sign = dot < 0 ? -1 : 1
  let len = 0
  for (let k = 3; k < 7; k++) {
    out[k] = prevPose[k] * b + curPose[k] * a * sign
    len += out[k] * out[k]
  }
  len = Math.sqrt(len) || 1
  for (let k = 3; k < 7; k++) out[k] /= len
  out[7] = prevPose[7] * b + curPose[7] * a

  const w = Math.min(1, Math.max(0, target.rest ?? 0))
  shownBlend = target.rest ?? 0
  if (w > 0) {
    s.restAt(target, restBuf)
    const v = 1 - w
    for (let i = 0; i < buffer.length; i++) buffer[i] = buffer[i] * v + restBuf[i] * w
    out[0] = out[0] * v + target.x * w
    out[1] = out[1] * v + target.y * w
    out[2] = out[2] * v + target.z * w
    // the hanger straightens and turns to the target yaw (nlerp toward R_y(yaw))
    const ty = Math.sin(target.yaw / 2), tw = Math.cos(target.yaw / 2)
    const sgn = out[4] * ty + out[6] * tw < 0 ? -1 : 1
    out[3] *= v
    out[4] = out[4] * v + ty * w * sgn
    out[5] *= v
    out[6] = out[6] * v + tw * w * sgn
    const l = Math.hypot(out[3], out[4], out[5], out[6]) || 1
    for (let k = 3; k < 7; k++) out[k] /= l
    out[7] = out[7] * v + target.yaw * w
  }
  reply({ type: 'frame', positions: buffer, pose: out, ms: stepMs }, buffer)
}

function reply(msg: WorkerOut, buffer: Float32Array) {
  ;(self as unknown as Worker).postMessage(msg, [buffer.buffer])
}
