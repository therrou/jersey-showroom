import type { JerseyMesh } from './JerseyGeometry'

/** Per-mesh scratch for skinning (particle normals). */
export interface SkinScratch {
  normals: Float32Array
}

export function createSkinScratch(mesh: JerseyMesh): SkinScratch {
  return { normals: new Float32Array(mesh.particles.length) }
}

/** Area-weighted particle normals from the particle triangles. */
function particleNormals(mesh: JerseyMesh, P: Float32Array, N: Float32Array) {
  N.fill(0)
  const t = mesh.triangles
  for (let k = 0; k < t.length; k += 3) {
    const a = t[k] * 3, b = t[k + 1] * 3, c = t[k + 2] * 3
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2]
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2]
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    N[a] += nx; N[a + 1] += ny; N[a + 2] += nz
    N[b] += nx; N[b + 1] += ny; N[b + 2] += nz
    N[c] += nx; N[c + 1] += ny; N[c + 2] += nz
  }
}

/** Render-vertex positions (xyz) from particle positions P, written into `out`. */
export function applySkin(mesh: JerseyMesh, P: Float32Array, out: Float32Array, scratch: SkinScratch) {
  const skin = mesh.skin
  if (skin.kind === 'direct') {
    const r2p = skin.renderToParticle
    for (let v = 0; v < r2p.length; v++) {
      const p = r2p[v] * 3
      out[v * 3] = P[p]
      out[v * 3 + 1] = P[p + 1]
      out[v * 3 + 2] = P[p + 2]
    }
    return
  }
  const N = scratch.normals
  particleNormals(mesh, P, N)
  const { tri, bary, offset } = skin
  const n = offset.length
  for (let v = 0; v < n; v++) {
    const i = v * 3
    const a = tri[i] * 3, b = tri[i + 1] * 3, c = tri[i + 2] * 3
    const u = bary[i], w1 = bary[i + 1], w2 = bary[i + 2]
    let nx = N[a] * u + N[b] * w1 + N[c] * w2
    let ny = N[a + 1] * u + N[b + 1] * w1 + N[c + 1] * w2
    let nz = N[a + 2] * u + N[b + 2] * w1 + N[c + 2] * w2
    const o = offset[v] / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1)
    nx *= o; ny *= o; nz *= o
    out[i] = P[a] * u + P[b] * w1 + P[c] * w2 + nx
    out[i + 1] = P[a + 1] * u + P[b + 1] * w1 + P[c + 1] * w2 + ny
    out[i + 2] = P[a + 2] * u + P[b + 2] * w1 + P[c + 2] * w2 + nz
  }
}

/** The particle that best represents render vertex v (for grabbing). */
export function pickParticle(mesh: JerseyMesh, v: number): number {
  const skin = mesh.skin
  if (skin.kind === 'direct') return skin.renderToParticle[v]
  const i = v * 3
  const { bary, tri } = skin
  const k = bary[i] >= bary[i + 1] && bary[i] >= bary[i + 2] ? 0 : bary[i + 1] >= bary[i + 2] ? 1 : 2
  return tri[i + k]
}
