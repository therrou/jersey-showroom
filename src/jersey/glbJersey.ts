import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { mergeSeamNormals, type BoundSkin, type JerseyMesh } from './JerseyGeometry'

/**
 * The Blender-built garment (tools/blender, public/models/jersey.glb):
 *   JerseyRender / JerseyRenderLow  draped render meshes. UV0 = kit atlas, UV1 = baked
 *                                   normal/AO maps. _PATX/_PATY flat-pattern position,
 *                                   _SIDE 0 front / 1 back / 2 seam, _PART 0 body /
 *                                   1 collar band / 2 rib facing.
 *   JerseyCage / JerseyCageLow      welded simulation tubes on the same drape.
 *                                   _PIN 1 where the cloth rests on the hanger.
 * Each render mesh is bound to a cage (cage triangle + barycentrics + normal offset) and
 * reconstructed from the particles after every solver step.
 */

export interface GlbJersey {
  high: JerseyMesh
  low: JerseyMesh
}

const MODEL_URL = '/models/jersey.glb'
const NORMAL_URL = '/models/jersey_normal.webp'
const AO_URL = '/models/jersey_ao.webp'

export async function loadGlbJersey(): Promise<GlbJersey> {
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  const tex = new THREE.TextureLoader()
  const [gltf, normal, ao] = await Promise.all([
    loader.loadAsync(MODEL_URL),
    tex.loadAsync(NORMAL_URL),
    tex.loadAsync(AO_URL),
  ])
  for (const t of [normal, ao]) {
    t.colorSpace = THREE.NoColorSpace
    t.channel = 1
    t.anisotropy = 8
  }
  const maps = { normal, ao }
  const get = (name: string) => {
    const o = gltf.scene.getObjectByName(name) as THREE.Mesh | undefined
    if (!o?.isMesh) throw new Error(`jersey.glb: missing ${name}`)
    return o.geometry as THREE.BufferGeometry
  }
  return {
    high: buildMesh(get('JerseyRender'), get('JerseyCage'), maps),
    low: buildMesh(get('JerseyRenderLow'), get('JerseyCageLow'), maps),
  }
}

// --- cage → constraints ---------------------------------------------------------------

interface Cage {
  particles: Float32Array
  triangles: Uint32Array
  edges: Uint32Array
  bends: Uint32Array
  thickness: Uint32Array
  pins: Uint32Array
  side: Float32Array
  pat: Float32Array // xy per particle
}

const attr = (g: THREE.BufferGeometry, name: string) => {
  const a = g.getAttribute(name)
  if (!a) throw new Error(`jersey.glb: missing attribute ${name}`)
  const out = new Float32Array(a.count * a.itemSize)
  for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k)
  return out
}

const indexOf = (g: THREE.BufferGeometry) => Uint32Array.from(g.getIndex()!.array as ArrayLike<number>)

function buildCage(g: THREE.BufferGeometry): Cage {
  const particles = attr(g, 'position')
  const triangles = indexOf(g)
  const side = attr(g, '_side')
  const px = attr(g, '_patx')
  const py = attr(g, '_paty')
  const pin = attr(g, '_pin')
  const n = side.length
  const pat = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    pat[i * 2] = px[i]
    pat[i * 2 + 1] = py[i]
  }

  // stretch/shear: every triangle edge; bending: across every interior edge, between the
  // two vertices opposite it (rest = the draped shape, so the drape's folds persist)
  const key = (a: number, b: number) => Math.min(a, b) * 1_000_003 + Math.max(a, b)
  const opposite = new Map<number, number[]>()
  const edges: number[] = []
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]]
    for (const [p, q, o] of [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ]) {
      const k = key(p, q)
      const list = opposite.get(k)
      if (list) list.push(o)
      else {
        opposite.set(k, [o])
        edges.push(Math.min(p, q), Math.max(p, q))
      }
    }
  }
  const bends: number[] = []
  for (const list of opposite.values()) if (list.length === 2) bends.push(list[0], list[1])

  // volume: the front and back particle at the same pattern point
  const back = new Map<string, number>()
  const pk = (i: number) => `${Math.round(px[i] * 1e4)},${Math.round(py[i] * 1e4)}`
  for (let i = 0; i < n; i++) if (side[i] === 1) back.set(pk(i), i)
  const thickness: number[] = []
  for (let i = 0; i < n; i++) {
    if (side[i] !== 0) continue
    const j = back.get(pk(i))
    if (j !== undefined) thickness.push(i, j)
  }

  const pins: number[] = []
  for (let i = 0; i < n; i++) if (pin[i] > 0.5) pins.push(i)

  return {
    particles,
    triangles,
    edges: new Uint32Array(edges),
    bends: new Uint32Array(bends),
    thickness: new Uint32Array(thickness),
    pins: new Uint32Array(pins),
    side,
    pat,
  }
}

// --- binding --------------------------------------------------------------------------

const CELL = 0.03

/** Barycentrics of q in 2D triangle (a, b, c), unclamped. */
function bary2(qx: number, qy: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number, out: number[]) {
  const v0x = bx - ax, v0y = by - ay, v1x = cx - ax, v1y = cy - ay, v2x = qx - ax, v2y = qy - ay
  const d = v0x * v1y - v1x * v0y
  const v = (v2x * v1y - v1x * v2y) / d
  const w = (v0x * v2y - v2x * v0y) / d
  out[0] = 1 - v - w
  out[1] = v
  out[2] = w
}

/** Barycentrics of the point on 3D triangle (a, b, c) closest to p (Ericson). */
function closestBary(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, out: number[]) {
  const tri = new THREE.Triangle(a, b, c)
  const q = tri.closestPointToPoint(p, new THREE.Vector3())
  const bc = tri.getBarycoord(q, new THREE.Vector3())!
  out[0] = bc.x
  out[1] = bc.y
  out[2] = bc.z
  return q.distanceToSquared(p)
}

function bind(render: THREE.BufferGeometry, cage: Cage): BoundSkin {
  const pos = render.getAttribute('position')
  const n = pos.count
  const side = attr(render, '_side')
  const part = attr(render, '_part')
  const px = attr(render, '_patx')
  const py = attr(render, '_paty')
  const T = cage.triangles
  const P = cage.particles
  const nt = T.length / 3

  // cage triangle sides, and pattern-space buckets per side
  const triSide = new Int8Array(nt)
  for (let t = 0; t < nt; t++) {
    let s = -1
    for (let k = 0; k < 3; k++) {
      const sv = cage.side[T[t * 3 + k]]
      if (sv !== 2) s = sv
    }
    triSide[t] = s
  }
  const buckets = [new Map<string, number[]>(), new Map<string, number[]>()]
  const bkey = (i: number, j: number) => `${i},${j}`
  for (let t = 0; t < nt; t++) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
    for (let k = 0; k < 3; k++) {
      const v = T[t * 3 + k]
      minx = Math.min(minx, cage.pat[v * 2]); maxx = Math.max(maxx, cage.pat[v * 2])
      miny = Math.min(miny, cage.pat[v * 2 + 1]); maxy = Math.max(maxy, cage.pat[v * 2 + 1])
    }
    for (const s of triSide[t] === -1 ? [0, 1] : [triSide[t]]) {
      for (let i = Math.floor(minx / CELL); i <= Math.floor(maxx / CELL); i++)
        for (let j = Math.floor(miny / CELL); j <= Math.floor(maxy / CELL); j++) {
          const k = bkey(i, j)
          const l = buckets[s].get(k)
          if (l) l.push(t)
          else buckets[s].set(k, [t])
        }
    }
  }
  // 3D buckets (for the collar band and facings, which aren't on the pattern)
  const b3 = new Map<string, number[]>()
  for (let t = 0; t < nt; t++) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) {
      lo[d] = Math.min(lo[d], P[T[t * 3 + k] * 3 + d])
      hi[d] = Math.max(hi[d], P[T[t * 3 + k] * 3 + d])
    }
    for (let i = Math.floor(lo[0] / CELL); i <= Math.floor(hi[0] / CELL); i++)
      for (let j = Math.floor(lo[1] / CELL); j <= Math.floor(hi[1] / CELL); j++)
        for (let k = Math.floor(lo[2] / CELL); k <= Math.floor(hi[2] / CELL); k++) {
          const key = `${i},${j},${k}`
          const l = b3.get(key)
          if (l) l.push(t)
          else b3.set(key, [t])
        }
  }

  // rest particle normals (area-weighted)
  const N = new Float32Array(P.length)
  for (let t = 0; t < nt; t++) {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]]
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]
    const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    for (const v of [a, b, c]) for (let d = 0; d < 3; d++) N[v + d] += nn[d]
  }

  const tri = new Uint32Array(n * 3)
  const bary = new Float32Array(n * 3)
  const offset = new Float32Array(n)
  const bc = [0, 0, 0]
  const best = [0, 0, 0]
  const x = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3()

  for (let v = 0; v < n; v++) {
    x.fromBufferAttribute(pos, v)
    let bt = -1
    if (part[v] === 0) {
      // on the pattern: barycentrics in pattern space, on the vertex's own piece
      let bestErr = Infinity
      const ci = Math.floor(px[v] / CELL), cj = Math.floor(py[v] / CELL)
      for (const s of side[v] === 2 ? [0, 1] : [side[v]]) {
        for (let r = 0; r <= 2 && bestErr > 0; r++) {
          for (let i = ci - r; i <= ci + r; i++)
            for (let j = cj - r; j <= cj + r; j++) {
              for (const t of buckets[s].get(bkey(i, j)) ?? []) {
                const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2]
                bary2(px[v], py[v], cage.pat[a * 2], cage.pat[a * 2 + 1], cage.pat[b * 2], cage.pat[b * 2 + 1], cage.pat[c * 2], cage.pat[c * 2 + 1], bc)
                const err = -Math.min(bc[0], bc[1], bc[2], 0)
                if (err < bestErr) {
                  bestErr = err
                  bt = t
                  best[0] = bc[0]; best[1] = bc[1]; best[2] = bc[2]
                }
              }
            }
          if (bt >= 0 && r >= 1) break
        }
      }
      // just off the coarser cage outline: clamp onto the triangle
      if (bt >= 0 && bestErr > 0) {
        for (let k = 0; k < 3; k++) best[k] = Math.max(best[k], 0)
        const s = best[0] + best[1] + best[2]
        for (let k = 0; k < 3; k++) best[k] /= s
      }
    }
    if (bt < 0) {
      // collar band / facings: closest point on the cage surface
      let bestD = Infinity
      const cx = Math.floor(x.x / CELL), cy = Math.floor(x.y / CELL), cz = Math.floor(x.z / CELL)
      for (let r = 0; r <= 3 && bt < 0; r++)
        for (let i = cx - r; i <= cx + r; i++)
          for (let j = cy - r; j <= cy + r; j++)
            for (let k = cz - r; k <= cz + r; k++)
              for (const t of b3.get(`${i},${j},${k}`) ?? []) {
                A.fromArray(P, T[t * 3] * 3)
                B.fromArray(P, T[t * 3 + 1] * 3)
                C.fromArray(P, T[t * 3 + 2] * 3)
                const d = closestBary(x, A, B, C, bc)
                if (d < bestD) {
                  bestD = d
                  bt = t
                  best[0] = bc[0]; best[1] = bc[1]; best[2] = bc[2]
                }
              }
    }
    const a = T[bt * 3], b = T[bt * 3 + 1], c = T[bt * 3 + 2]
    tri[v * 3] = a; tri[v * 3 + 1] = b; tri[v * 3 + 2] = c
    bary[v * 3] = best[0]; bary[v * 3 + 1] = best[1]; bary[v * 3 + 2] = best[2]
    // offset along the interpolated normal from the cage surface point
    let sx = 0, sy = 0, sz = 0, nx = 0, ny = 0, nz = 0
    for (let k = 0; k < 3; k++) {
      const p = T[bt * 3 + k] * 3
      sx += P[p] * best[k]; sy += P[p + 1] * best[k]; sz += P[p + 2] * best[k]
      nx += N[p] * best[k]; ny += N[p + 1] * best[k]; nz += N[p + 2] * best[k]
    }
    const nl = Math.hypot(nx, ny, nz) || 1
    offset[v] = ((x.x - sx) * nx + (x.y - sy) * ny + (x.z - sz) * nz) / nl
  }
  return { kind: 'bound', tri, bary, offset }
}

// --- render mesh ------------------------------------------------------------------------

/** Render vertices at the same place (UV splits along seams): merge their normals. */
function findSeamPairs(g: THREE.BufferGeometry): Uint32Array {
  const pos = g.getAttribute('position')
  const seen = new Map<string, number>()
  const pairs: number[] = []
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`
    const j = seen.get(k)
    if (j === undefined) seen.set(k, i)
    else pairs.push(j, i)
  }
  return new Uint32Array(pairs)
}

/** Signed distance to the front-view (x/y) silhouette of the body, from a raster. */
function buildOutline(g: THREE.BufferGeometry, part: Float32Array, bounds: THREE.Box3) {
  const cell = 0.008
  const x0 = bounds.min.x - 0.05, y0 = bounds.min.y - 0.05
  const W = Math.ceil((bounds.max.x - bounds.min.x + 0.1) / cell)
  const H = Math.ceil((bounds.max.y - bounds.min.y + 0.1) / cell)
  const inside = new Uint8Array(W * H)
  const pos = g.getAttribute('position')
  const idx = g.getIndex()!
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2)
    if (part[a] !== 0) continue
    const ax = (pos.getX(a) - x0) / cell, ay = (pos.getY(a) - y0) / cell
    const bx = (pos.getX(b) - x0) / cell, by = (pos.getY(b) - y0) / cell
    const cx = (pos.getX(c) - x0) / cell, cy = (pos.getY(c) - y0) / cell
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(d) < 1e-9) continue
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)))
    const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), j1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)))
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const l1 = ((by - cy) * (i + 0.5 - cx) + (cx - bx) * (j + 0.5 - cy)) / d
        const l2 = ((cy - ay) * (i + 0.5 - cx) + (ax - cx) * (j + 0.5 - cy)) / d
        if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) inside[j * W + i] = 1
      }
  }
  // two-pass chamfer distance to the other region, both ways
  const dist = (target: number) => {
    const D = new Float32Array(W * H).fill(1e6)
    for (let k = 0; k < W * H; k++) if (inside[k] === target) D[k] = 0
    const R2 = Math.SQRT2
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i
        if (i > 0) D[k] = Math.min(D[k], D[k - 1] + 1)
        if (j > 0) D[k] = Math.min(D[k], D[k - W] + 1)
        if (i > 0 && j > 0) D[k] = Math.min(D[k], D[k - W - 1] + R2)
        if (i < W - 1 && j > 0) D[k] = Math.min(D[k], D[k - W + 1] + R2)
      }
    for (let j = H - 1; j >= 0; j--)
      for (let i = W - 1; i >= 0; i--) {
        const k = j * W + i
        if (i < W - 1) D[k] = Math.min(D[k], D[k + 1] + 1)
        if (j < H - 1) D[k] = Math.min(D[k], D[k + W] + 1)
        if (i < W - 1 && j < H - 1) D[k] = Math.min(D[k], D[k + W + 1] + R2)
        if (i > 0 && j < H - 1) D[k] = Math.min(D[k], D[k + W - 1] + R2)
      }
    return D
  }
  const dOut = dist(1) // outside cells: distance to the garment
  const dIn = dist(0) // inside cells: distance to the outside
  return (x: number, y: number) => {
    const i = Math.floor((x - x0) / cell), j = Math.floor((y - y0) / cell)
    if (i < 0 || j < 0 || i >= W || j >= H) return -1
    const k = j * W + i
    return (inside[k] ? dIn[k] : -dOut[k]) * cell
  }
}

function buildMesh(renderSrc: THREE.BufferGeometry, cageSrc: THREE.BufferGeometry, maps: JerseyMesh['maps']): JerseyMesh {
  const cage = buildCage(cageSrc)
  const geometry = new THREE.BufferGeometry()
  geometry.setIndex(Array.from(indexOf(renderSrc)))
  geometry.setAttribute('position', new THREE.BufferAttribute(attr(renderSrc, 'position'), 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(attr(renderSrc, 'normal'), 3))
  // glTF stores v downward; the kit canvases and the baked maps are v-up (flipY)
  for (const [from, to] of [
    ['uv', 'uv'],
    ['uv1', 'uv1'],
  ] as const) {
    const uv = attr(renderSrc, from)
    for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - uv[i]
    geometry.setAttribute(to, new THREE.BufferAttribute(uv, 2))
  }
  const count = geometry.getAttribute('position').count
  // AO comes from the baked map; the per-vertex term stays neutral
  geometry.setAttribute('aAO', new THREE.BufferAttribute(new Float32Array(count).fill(1), 1))
  const part = attr(renderSrc, '_part')
  const seamPairs = findSeamPairs(geometry)
  mergeSeamNormals(geometry, seamPairs)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  const bounds = geometry.boundingBox!.clone()

  return {
    geometry,
    particles: cage.particles,
    triangles: cage.triangles,
    skin: bind(renderSrc, cage),
    seamPairs,
    edges: cage.edges,
    bends: cage.bends,
    thickness: cage.thickness,
    pins: cage.pins,
    draped: true,
    outline: buildOutline(geometry, part, bounds),
    bounds,
    maps,
  }
}
