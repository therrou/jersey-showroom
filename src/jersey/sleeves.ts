import * as THREE from 'three'
import type { JerseyMesh } from './JerseyGeometry'
import { LANDMARKS } from './silhouette'

/**
 * Sleeve rig for the per-jersey drape variety: every render vertex gets a signed sleeve
 * weight (`aSleeve`: + on the +x sleeve, − on the other, 0 on the body, blended across the
 * armhole), and each sleeve a pivot at its draped shoulder point. The rack shader swings
 * each sleeve about its pivot by a seeded amount (fabricMaterial), and variety.ts does the
 * same to the cloth's particles (`particles`: one weight per particle).
 *
 * Sleeve vs body comes from the flat pattern: signed distance outward from the hinge line
 * shoulder → between the cuff and the side seam (the same split the Blender drape uses).
 */
export interface SleeveRig {
  /** Draped shoulder pivots of the +x and −x sleeves (garment space). */
  pivotR: THREE.Vector3
  pivotL: THREE.Vector3
  /** Signed sleeve weight per simulation particle. */
  particles: Float32Array
}

// the side seam at the cuff's height (silhouette.ts RIGHT_HALF), as in tools/blender/drape.py
const SIDE_SEAM: [number, number] = [0.326, -0.62]
const HINGE_IN = -0.01 // weight 0 this far inside the hinge line (m, on the pattern)
const HINGE_OUT = 0.06 // weight 1 this far outside it

const [SX, SY] = LANDMARKS.shoulder
const HX = (LANDMARKS.cuffInner[0] + SIDE_SEAM[0]) / 2 - SX
const HY = (LANDMARKS.cuffInner[1] + SIDE_SEAM[1]) / 2 - SY
const HL = Math.hypot(HX, HY)

/** Distance outward from the hinge line (+ = sleeve) at a pattern point. */
const hingeDistance = (px: number, py: number) => -((Math.abs(px) - SX) * HY - (py - SY) * HX) / HL

/** Signed sleeve weight at a pattern point. */
export const sleeveWeight = (px: number, py: number) =>
  THREE.MathUtils.smoothstep(hingeDistance(px, py), HINGE_IN, HINGE_OUT) * (px >= 0 ? 1 : -1)

const cache = new WeakMap<JerseyMesh, SleeveRig>()

export function sleeveRig(mesh: JerseyMesh): SleeveRig {
  const hit = cache.get(mesh)
  if (hit) return hit
  const g = mesh.geometry
  const pos = g.getAttribute('position')
  const n = pos.count
  const w = new Float32Array(n)
  const np = mesh.particles.length / 3
  const rig: SleeveRig = { pivotR: new THREE.Vector3(), pivotL: new THREE.Vector3(), particles: new Float32Array(np) }
  const skin = mesh.skin
  const pat = mesh.pattern
  // only the Blender garment knows its pattern per vertex; the procedural fallback keeps
  // its sleeves as they are (weights 0)
  if (skin.kind === 'bound' && pat) {
    for (let i = 0; i < np; i++) rig.particles[i] = sleeveWeight(pat[i * 2], pat[i * 2 + 1])
    const sum = [new THREE.Vector3(), new THREE.Vector3()]
    const count = [0, 0]
    for (let v = 0; v < n; v++) {
      // pattern position of the vertex, through its cage binding
      let px = 0, py = 0
      for (let k = 0; k < 3; k++) {
        const b = skin.bary[v * 3 + k]
        const t = skin.tri[v * 3 + k]
        px += b * pat[t * 2]
        py += b * pat[t * 2 + 1]
      }
      w[v] = sleeveWeight(px, py)
      // pivot: the draped shoulder point (on the hinge line, near the shoulder)
      if (Math.abs(hingeDistance(px, py)) < 0.015 && Math.hypot(Math.abs(px) - SX, py - SY) < 0.05) {
        const side = px >= 0 ? 0 : 1
        sum[side].add(new THREE.Vector3().fromBufferAttribute(pos, v))
        count[side]++
      }
    }
    if (count[0]) rig.pivotR.copy(sum[0]).divideScalar(count[0])
    if (count[1]) rig.pivotL.copy(sum[1]).divideScalar(count[1])
  }
  g.setAttribute('aSleeve', new THREE.BufferAttribute(w, 1))
  cache.set(mesh, rig)
  return rig
}
