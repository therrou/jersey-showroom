/// <reference lib="webworker" />
import { ClothSolver, type ClothConfig, type ClothInit, type ClothInput } from './ClothSolver'

export type WorkerIn =
  | { type: 'init'; init: ClothInit; cfg: ClothConfig; settleSteps: number }
  | { type: 'step'; input: ClothInput; buffer: Float32Array }

export type WorkerOut = { type: 'frame'; positions: Float32Array; pose: Float32Array }

let solver: ClothSolver | null = null

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data
  if (msg.type === 'init') {
    solver = new ClothSolver(msg.init)
    // let it hang and settle at the spawn pose before the first frame is shown
    const still = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, on: false }
    solver.settle(msg.settleSteps, { dt: 1 / 60, cfg: msg.cfg, target: msg.init.start, wind: still, grab: null })
    post(new Float32Array(solver.n * 3))
    return
  }
  if (!solver) return
  solver.step(msg.input)
  post(msg.buffer.length === solver.n * 3 ? msg.buffer : new Float32Array(solver.n * 3))
}

function post(buffer: Float32Array) {
  const s = solver!
  buffer.set(s.pos)
  const pose = new Float32Array(7)
  s.hangerPose(pose, 0)
  ;(self as unknown as Worker).postMessage({ type: 'frame', positions: buffer, pose } satisfies WorkerOut, [buffer.buffer])
}
