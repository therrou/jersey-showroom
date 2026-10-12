import type { Quality } from '../state/store'
import { JERSEYS } from '../data/jerseys'
import { loadGlbJersey, type GlbJersey } from './glbJersey'
import { buildProceduralJersey, type JerseyMesh } from './JerseyGeometry'
import { createJerseyKit, type JerseyKit } from './jerseyTexture'

/**
 * Jersey meshes for the rack and the modal cloth.
 * Default: the Blender-built garment (public/models/jersey.glb). `?mesh=procedural`
 * forces the procedural mesh, which is also the automatic fallback if the GLB fails.
 */
export interface JerseyAssets {
  source: 'glb' | 'procedural'
  /** Static render mesh for the rack. */
  rack(quality: Quality): JerseyMesh
  /** Simulated mesh for the modal; `grid` sizes the procedural fallback. */
  cloth(quality: Quality, grid: { cols: number; rows: number }): JerseyMesh
}

const forceProcedural =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('mesh') === 'procedural'

function proceduralAssets(): JerseyAssets {
  let rack: JerseyMesh | null = null
  const cloth = new Map<string, JerseyMesh>()
  return {
    source: 'procedural',
    rack() {
      rack ??= buildProceduralJersey({ cols: 60, rows: 44 })
      return rack
    },
    cloth(_q, { cols, rows }) {
      const key = `${cols}x${rows}`
      if (!cloth.has(key)) cloth.set(key, buildProceduralJersey({ cols, rows }))
      return cloth.get(key)!
    },
  }
}

function glbAssets(glb: GlbJersey): JerseyAssets {
  return {
    source: 'glb',
    rack: (q) => (q === 'high' ? glb.high : glb.low),
    cloth: (q) => (q === 'high' ? glb.high : glb.low),
  }
}

let assets: Promise<JerseyAssets> | null = null
/** Loads once; safe to `use()` from any component under a Suspense boundary. */
export function jerseyAssets(): Promise<JerseyAssets> {
  assets ??= forceProcedural
    ? Promise.resolve(proceduralAssets())
    : loadGlbJersey().then(glbAssets, (err) => {
        console.warn('[jersey] GLB failed to load, using the procedural mesh:', err)
        return proceduralAssets()
      })
  return assets
}

const kits = new Map<string, Promise<JerseyKit>>()
/** Kit maps for jersey `index` at colour-atlas width `width` (cached; safe to call early to warm). */
export function jerseyKit(index: number, width: number): Promise<JerseyKit> {
  const key = `${index}@${width}`
  if (!kits.has(key)) kits.set(key, createJerseyKit(JERSEYS[index], width))
  return kits.get(key)!
}
