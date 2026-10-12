import Delaunator from 'delaunator'
import * as THREE from 'three'
import { BOUNDS, LANDMARKS, SHOULDER_PINS, SILHOUETTE, signedDistance, type Vec2 } from './silhouette'

/**
 * Everything the rack renderer and the cloth solver need from a jersey mesh.
 * Two implementations: the GLB garment (src/jersey/glbJersey.ts: a draped render mesh
 * bound to a simulation cage) and the procedural fallback below.
 */
export interface JerseyMesh {
  /** Render geometry in rest pose. UV atlas: front in u∈[0,0.5], back in u∈[0.5,1]. Has `aAO`. */
  geometry: THREE.BufferGeometry
  /** Rest positions of the unique simulation particles (xyz). */
  particles: Float32Array
  /** Particle triangles (aerodynamic drag). */
  triangles: Uint32Array
  /** How render vertices follow the particles. */
  skin: JerseySkin
  /** Render vertices sitting at the same place on a seam (their normals get merged). */
  seamPairs: Uint32Array
  /** Structural + shear distance constraints, particle index pairs. */
  edges: Uint32Array
  /** Front/back pairs that keep the garment's volume. */
  thickness: Uint32Array
  /** Particles held by the hanger. */
  pins: Uint32Array
  /** Flat-pattern xy per particle, if known (stretch rests on the uncompressed fabric). */
  pattern?: Float32Array
  /** Drape variants (relative particle offsets, 3 per particle), if baked: see variety.ts. */
  drapes?: Float32Array[]
  /** The particles' rest shape is already the hanging drape (the solver keeps it as is);
   *  otherwise it's the flat pattern and the solver folds a drape into it. */
  draped: boolean
  /** Signed distance (m) to the garment's front-view outline in garment space, positive
   *  inside: where the rack's cursor brush touches fabric. */
  outline: (x: number, y: number) => number
  /** Garment-space bounds of the render mesh. */
  bounds: THREE.Box3
  /** Baked tangent-space normal + AO maps (UV1), if the mesh has them. */
  maps?: { normal: THREE.Texture; ao: THREE.Texture }
}

/** One particle per render vertex (seams share particles). */
export interface DirectSkin {
  kind: 'direct'
  renderToParticle: Uint32Array
}

/** Each render vertex rides on a particle triangle: barycentric position plus an offset
 *  along the triangle's interpolated normal. */
export interface BoundSkin {
  kind: 'bound'
  /** 3 particle indices per render vertex. */
  tri: Uint32Array
  /** 3 barycentric weights per render vertex. */
  bary: Float32Array
  /** Offset from the surface point in its local frame (tangent, bitangent, normal; see
   *  `surfaceFrame` in skin.ts), 3 per render vertex. */
  offset: Float32Array
}

export type JerseySkin = DirectSkin | BoundSkin

export interface BuildOptions {
  cols: number
  rows: number
}

// Cross-section: two fabric layers that meet in a rounded fold at the outline (radius
// EDGE_R), then sit a little apart through the body (air + hanger), like a real
// garment hanging flat — not a pillow with a pinched seam.
const EDGE_R = 0.012
const PUFF = 0.012

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Half-thickness at signed distance d from the outline. */
function halfThickness(d: number, y: number): number {
  if (d <= 0) return 0
  const t = Math.min(d, EDGE_R) / EDGE_R
  const round = EDGE_R * Math.sqrt(1 - (1 - t) * (1 - t))
  const body = 0.6 + 0.4 * smoothstep(-0.05, -0.3, y) // the hanger flattens the shoulders
  return round + PUFF * smoothstep(EDGE_R, 0.14, d) * body
}

function distToSegment(px: number, py: number, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)))
  return { d: Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)), t }
}

/**
 * Baked ambient occlusion for the hanging shape: the armpit fold, the narrow gap where
 * the sleeve hangs against the body, and the collar under the hanger bar.
 */
function bakeAO(x: number, y: number): number {
  const ax = Math.abs(x)
  const { armpit, cuffInner } = LANDMARKS
  const side: Vec2 = [0.326, -0.62]
  let ao = 1
  const da = Math.hypot(ax - armpit[0], y - armpit[1])
  ao *= 1 - 0.3 * Math.exp(-((da / 0.09) ** 2))
  for (const seg of [cuffInner, side]) {
    const { d, t } = distToSegment(ax, y, armpit, seg)
    ao *= 1 - 0.16 * Math.exp(-((d / 0.035) ** 2)) * (1 - smoothstep(0.1, 0.9, t))
  }
  ao *= 1 - 0.2 * Math.exp(-((x / 0.11) ** 2 + ((y + 0.01) / 0.045) ** 2))
  return ao
}

/** Shoulder line the hanger bar follows, y as a function of x. */
function shoulderY(x: number): number {
  const pts = SHOULDER_PINS
  if (x <= pts[0][0]) return pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1]
      const [x1, y1] = pts[i]
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0)
    }
  }
  return pts[pts.length - 1][1]
}

/** Seam vertices: give the front and back copy the same (averaged) normal → round edge. */
export function mergeSeamNormals(geometry: THREE.BufferGeometry, seamPairs: Uint32Array) {
  const n = geometry.getAttribute('normal') as THREE.BufferAttribute
  const a = n.array as Float32Array
  for (let k = 0; k < seamPairs.length; k += 2) {
    const i = seamPairs[k] * 3
    const j = seamPairs[k + 1] * 3
    let x = a[i] + a[j]
    let y = a[i + 1] + a[j + 1]
    let z = a[i + 2] + a[j + 2]
    const l = Math.hypot(x, y, z)
    // front and back facing exactly opposite (flat edge): no meaningful average, and a
    // zero normal would become NaN in the shader (which bloom then smears everywhere)
    if (l < 0.05) continue
    x /= l
    y /= l
    z /= l
    a[i] = a[j] = x
    a[i + 1] = a[j + 1] = y
    a[i + 2] = a[j + 2] = z
  }
  n.needsUpdate = true
}

/** Outline resampled to ~`spacing`, keeping every corner of the pattern. */
function resampleOutline(spacing: number): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < SILHOUETTE.length; i++) {
    const a = SILHOUETTE[i]
    const b = SILHOUETTE[(i + 1) % SILHOUETTE.length]
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing))
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
  }
  return out
}

/**
 * Conforming mesh: points spaced evenly along the outline + an interior grid kept clear
 * of the edge, Delaunay-triangulated and trimmed to the pattern. The outline is exact
 * (no notches), and the edge ring is clean enough for the rounded fold profile.
 */
export function buildProceduralJersey({ cols, rows }: BuildOptions): JerseyMesh {
  const W = BOUNDS.width
  const H = BOUNDS.height
  const cw = W / cols
  const ch = H / rows
  const cell = Math.min(cw, ch)

  const pts: Vec2[] = resampleOutline(cell)
  const nBoundary = pts.length
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const x = BOUNDS.minX + i * cw
      const y = BOUNDS.maxY - j * ch
      if (signedDistance(x, y) > cell * 0.55) pts.push([x, y])
    }
  }
  const dist = pts.map(([x, y], k) => (k < nBoundary ? 0 : signedDistance(x, y)))

  // triangulate, then drop anything outside the pattern (collar dip, sleeve/body gap)
  const del = Delaunator.from(pts)
  const inside = (x: number, y: number) => signedDistance(x, y) > -0.002
  const tris: number[] = []
  for (let t = 0; t < del.triangles.length; t += 3) {
    let [p, q, r] = [del.triangles[t], del.triangles[t + 1], del.triangles[t + 2]]
    const [a, b, c] = [pts[p], pts[q], pts[r]]
    if (!inside((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3)) continue
    if (!inside((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) continue
    if (!inside((b[0] + c[0]) / 2, (b[1] + c[1]) / 2)) continue
    if (!inside((c[0] + a[0]) / 2, (c[1] + a[1]) / 2)) continue
    // counter-clockwise seen from the front (+z)
    if ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]) < 0) [q, r] = [r, q]
    tris.push(p, q, r)
  }
  const used = new Uint8Array(pts.length)
  for (const k of tris) used[k] = 1

  // Particles: front for every point, a back twin where the garment has thickness.
  const front = new Int32Array(pts.length).fill(-1)
  const back = new Int32Array(pts.length).fill(-1)
  const particles: number[] = []
  const thickness: number[] = []
  pts.forEach(([x, y], k) => {
    if (!used[k]) return
    const h = halfThickness(dist[k], y)
    front[k] = particles.length / 3
    particles.push(x, y, h)
    if (h > 0.0015) {
      back[k] = particles.length / 3
      particles.push(x, y, -h)
      thickness.push(front[k], back[k])
    } else {
      back[k] = front[k]
    }
  })

  // Render vertices: front sheet + back sheet (seam particles duplicated for their UVs).
  const positions: number[] = []
  const uvs: number[] = []
  const aos: number[] = []
  const r2p: number[] = []
  const frontV = new Int32Array(pts.length).fill(-1)
  const backV = new Int32Array(pts.length).fill(-1)
  const seamPairs: number[] = []
  const pushVertex = (k: number, p: number, side: 0 | 1) => {
    const [x, y] = pts[k]
    positions.push(particles[p * 3], particles[p * 3 + 1], particles[p * 3 + 2])
    const u = (x - BOUNDS.minX) / W
    const v = (y - BOUNDS.minY) / H
    // back art is authored as seen from behind, so mirror u on that half
    uvs.push(side === 0 ? u * 0.5 : 0.5 + (1 - u) * 0.5, v)
    aos.push(bakeAO(x, y))
    r2p.push(p)
    return positions.length / 3 - 1
  }
  pts.forEach((_, k) => {
    if (!used[k]) return
    frontV[k] = pushVertex(k, front[k], 0)
    backV[k] = pushVertex(k, back[k], 1)
    if (front[k] === back[k]) seamPairs.push(frontV[k], backV[k])
  })

  const indices: number[] = []
  for (let t = 0; t < tris.length; t += 3) {
    const [p, q, r] = [tris[t], tris[t + 1], tris[t + 2]]
    indices.push(frontV[p], frontV[q], frontV[r])
    indices.push(backV[p], backV[r], backV[q])
  }

  // Constraints (deduplicated: seam points appear on both sheets).
  // Stretch/shear: every triangle edge (the solver bends across them).
  const seen = new Set<number>()
  const edges: number[] = []
  const key = (p: number, q: number) => Math.min(p, q) * 1_000_003 + Math.max(p, q)
  const addPair = (list: number[], p: number, q: number) => {
    if (p === q) return
    const k = key(p, q)
    if (seen.has(k)) return
    seen.add(k)
    list.push(Math.min(p, q), Math.max(p, q))
  }
  for (const sheet of [front, back]) {
    for (let t = 0; t < tris.length; t += 3) {
      const [p, q, r] = [sheet[tris[t]], sheet[tris[t + 1]], sheet[tris[t + 2]]]
      for (const [a, b] of [
        [p, q],
        [q, r],
        [r, p],
      ])
        addPair(edges, a, b)
    }
  }

  // Pin everything sitting on the hanger bar.
  const pinSet = new Set<number>()
  pts.forEach(([x, y], k) => {
    if (!used[k]) return
    if (Math.abs(x) <= 0.215 && y >= shoulderY(x) - ch * 0.9) {
      pinSet.add(front[k])
      pinSet.add(back[k])
    }
  })

  const r2pArr = new Uint32Array(r2p)
  const triangles = new Uint32Array(indices.length)
  for (let k = 0; k < indices.length; k++) triangles[k] = r2pArr[indices[k]]

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('aAO', new THREE.Float32BufferAttribute(aos, 1))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const seams = new Uint32Array(seamPairs)
  mergeSeamNormals(geometry, seams)
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()

  return {
    geometry,
    particles: new Float32Array(particles),
    triangles,
    skin: { kind: 'direct', renderToParticle: r2pArr },
    seamPairs: seams,
    edges: new Uint32Array(edges),
    thickness: new Uint32Array(thickness),
    pins: new Uint32Array([...pinSet]),
    draped: false,
    outline: (x, y) => signedDistance(x, y),
    bounds: geometry.boundingBox!.clone(),
  }
}
