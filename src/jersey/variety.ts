import * as THREE from 'three'
import type { JerseyMesh } from './JerseyGeometry'
import { sleeveRig } from './sleeves'

/**
 * Per-jersey drape variety, so the rack doesn't look cloned. Every copy of a jersey uses
 * the same shape: the rack draws it (morph targets + the static part of the fabric
 * shader's displacement), and the modal's cloth starts from, and rests in, the same shape
 * (`restParticles`), so turning out, lifting off and putting back never reshape it.
 *
 *  - drapes: weights over the drape variants baked in Blender (tools/blender/variants.py);
 *    each jersey mostly hangs in one of base + N (neighbours never share it), with a little
 *    of another mixed in
 *  - sleeve: swing forward / splay outward about each shoulder (sleeves.ts)
 *  - hem: tilt front/back and side to side
 *  - body: lower-body twist, hem opening, forward shift, side-edge wave
 *  - fold: × the shader's seeded fold depth
 */
export interface Variety {
  seed: number
  drapes: number[]
  /** Swing (+x sleeve), splay (+x), swing (−x), splay (−x), radians. */
  sleeve: THREE.Vector4
  hem: THREE.Vector2
  body: THREE.Vector4
  /** The shader's fold depth (uFold). */
  fold: number
}

// Sleeves hang just in front of the body's sides, so they swing mostly forward, and always
// splay out a little (small: the baked variants already vary the sleeves, and a bigger
// splay pushes the underarm out into a bump).
const SWING = [-0.03, 0.08] // rad, + = cuff forward
const SPLAY = [0.01, 0.035] // rad, cuff outward
const HEM_TILT_Z = 0.22 // ± drop per metre toward the front
const HEM_TILT_X = 0.05 // ± drop per metre to the side
const FOLD = [0.55, 1.6] // × the base fold depth
const BODY_TWIST = 0.1 // ± rad at the hem
const HEM_OPEN = 0.35 // ± × the tube's depth at the hem
const HEM_SHIFT = 0.015 // ± m forward/back at the hem
const EDGE_WAVE = 0.012 // up to m
const DRAPE_MIX = [0.15, 0.35]

/** The rack's and the cloth's per-jersey seed. */
export const jerseySeed = (index: number) => index * 1.37 + 0.31

/** Deterministic 0–1 noise from a seed and a channel. */
const hash = (seed: number, k: number) => {
  const x = Math.sin(seed * 127.1 + k * 311.7) * 43758.5453
  return x - Math.floor(x)
}
const lerp = THREE.MathUtils.lerp

function drapeWeights(index: number, seed: number, variants: number) {
  const w = new Array<number>(variants).fill(0)
  if (!variants) return w
  const n = variants + 1
  const main = (index * 3 + 1) % n
  const other = (main + 1 + Math.floor(hash(seed, 12) * (n - 1))) % n
  const share = lerp(DRAPE_MIX[0], DRAPE_MIX[1], hash(seed, 13))
  if (main) w[main - 1] += 1 - share
  if (other) w[other - 1] += share
  return w
}

export function jerseyVariety(index: number, mesh: JerseyMesh): Variety {
  const seed = jerseySeed(index)
  // the GLB garment already hangs in real folds: the shader's seeded ones only add a little
  const base = mesh.draped ? 0.33 : 1
  return {
    seed,
    drapes: drapeWeights(index, seed, mesh.drapes?.length ?? 0),
    sleeve: new THREE.Vector4(
      lerp(SWING[0], SWING[1], hash(seed, 1)),
      lerp(SPLAY[0], SPLAY[1], hash(seed, 2)),
      lerp(SWING[0], SWING[1], hash(seed, 3)),
      lerp(SPLAY[0], SPLAY[1], hash(seed, 4)),
    ),
    hem: new THREE.Vector2((hash(seed, 5) * 2 - 1) * HEM_TILT_Z, (hash(seed, 6) * 2 - 1) * HEM_TILT_X),
    body: new THREE.Vector4(
      (hash(seed, 8) * 2 - 1) * BODY_TWIST,
      (hash(seed, 9) * 2 - 1) * HEM_OPEN,
      (hash(seed, 10) * 2 - 1) * HEM_SHIFT,
      hash(seed, 11) * EDGE_WAVE,
    ),
    fold: base * lerp(FOLD[0], FOLD[1], hash(seed, 7)),
  }
}

/**
 * The jersey's rest shape as simulation particles: the base drape + its variant blend, then
 * the same static displacement the rack's shader applies (fabricMaterial: `sleevePose`,
 * then `clothDisplace` with the motion terms at rest). Keep the two in step.
 */
export function restParticles(mesh: JerseyMesh, v: Variety): Float32Array {
  const out = new Float32Array(mesh.particles)
  const n = out.length / 3
  v.drapes.forEach((w, k) => {
    const d = mesh.drapes![k]
    if (w) for (let i = 0; i < out.length; i++) out[i] += d[i] * w
  })
  const rig = sleeveRig(mesh)
  const { sleeve: sl, hem, body } = v
  for (let i = 0; i < n; i++) {
    let x = out[i * 3], y = out[i * 3 + 1], z = out[i * 3 + 2]
    // sleevePose
    const sw = rig.particles[i]
    if (sw !== 0) {
      const a = Math.abs(sw)
      const right = sw >= 0
      const pv = sw > 0 ? rig.pivotR : rig.pivotL
      let dx = x - pv.x, dy = y - pv.y, dz = z - pv.z
      const ax = -(right ? sl.x : sl.z) * a
      const az = (right ? sl.y : -sl.w) * a
      let c = Math.cos(ax), s = Math.sin(ax)
      const ty = dy * c - dz * s
      dz = dy * s + dz * c
      dy = ty
      c = Math.cos(az); s = Math.sin(az)
      const tx = dx * c - dy * s
      dy = dx * s + dy * c
      dx = tx
      x = pv.x + dx; y = pv.y + dy; z = pv.z + dz
    }
    // clothDisplace, at rest
    const hang = THREE.MathUtils.clamp(-y / 0.84, 0, 1)
    const h2 = hang * hang
    const folds = Math.sin(x * 11 + v.seed * 3.1) * 0.6 + Math.sin(x * 23 + v.seed * 7.7 + y * 3) * 0.4
    z += folds * 0.015 * hang * v.fold
    x *= 1 - 0.04 * h2 * v.fold
    y += (hem.x * z + hem.y * x) * h2
    z = z * (1 + body.y * h2) + body.z * h2 + body.w * Math.sin(y * 9 + v.seed * 5.3) * hang
    const tb = body.x * h2
    const cb = Math.cos(tb), sb = Math.sin(tb)
    const nx = cb * x - sb * z
    z = sb * x + cb * z
    x = nx
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z
  }
  return out
}
