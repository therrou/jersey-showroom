/// <reference lib="webworker" />
import { ClothSolver, type ClothConfig, type ClothInit, type ClothInput } from './ClothSolver'

export type WorkerIn =
  | { type: 'init'; init: ClothInit; cfg: ClothConfig; settleSteps: number }
  | { type: 'step'; input: ClothInput; buffer: Float32Array }

/** `frame`: new positions + hanger pose. `idle`: nothing moved (asleep); the buffer comes back unused. */
export type WorkerOut =
  | { type: 'frame'; positions: Float32Array; pose: Float32Array }
  | { type: 'idle'; buffer: Float32Array }

// Fixed timestep ("fix your timestep"): the solver always advances in 1/60 s steps,
// whatever the display rate, and what's shown is interpolated between the last two
// steps. On a 120 Hz display that halves the work and keeps the motion identical.
const FIXED = 1 / 60
const MAX_STEPS = 2 // per message; any further backlog is dropped (slow motion beats a spiral)

let solver: ClothSolver | null = null
let acc = 0
let prevPos = new Float32Array(0)
const prevPose = new Float32Array(8)
const curPose = new Float32Array(8)
/** The last frame posted already shows the sleeping cloth exactly. */
let shownAsleep = false

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data
  if (msg.type === 'init') {
    solver = new ClothSolver(msg.init)
    // let it hang and settle at the spawn pose before the first frame is shown
    const still = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, on: false }
    solver.settle(msg.settleSteps, { dt: FIXED, cfg: msg.cfg, target: msg.init.start, wind: still, grab: null })
    prevPos = new Float32Array(solver.pos)
    pose(solver, prevPose)
    acc = 0
    shownAsleep = false
    post(new Float32Array(solver.n * 3), 1)
    return
  }
  if (!solver) return
  const s = solver
  acc += Math.min(msg.input.dt, 0.1)
  let steps = 0
  while (acc >= FIXED && steps < MAX_STEPS) {
    prevPos.set(s.pos)
    pose(s, prevPose)
    s.step({ ...msg.input, dt: FIXED })
    acc -= FIXED
    steps++
  }
  if (acc >= FIXED) acc %= FIXED
  if (s.asleep) {
    // nothing moves: show the resting pose once, then stay quiet
    if (shownAsleep) return reply({ type: 'idle', buffer: msg.buffer }, msg.buffer)
    prevPos.set(s.pos)
    pose(s, prevPose)
    shownAsleep = true
  } else shownAsleep = false
  post(msg.buffer.length === s.n * 3 ? msg.buffer : new Float32Array(s.n * 3), acc / FIXED)
}

function pose(s: ClothSolver, out: Float32Array) {
  s.hangerPose(out, 0)
  out[7] = s.yaw // unwrapped, so a put-back can continue from it
}

/** Post positions and pose interpolated between the previous and the current step. */
function post(buffer: Float32Array, alpha: number) {
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
  reply({ type: 'frame', positions: buffer, pose: out }, buffer)
}

function reply(msg: WorkerOut, buffer: Float32Array) {
  ;(self as unknown as Worker).postMessage(msg, [buffer.buffer])
}
