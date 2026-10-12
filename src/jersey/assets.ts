import * as THREE from 'three'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { JERSEYS, type Jersey } from '../data/jerseys'
import { track } from '../state/loading'
import type { Quality } from '../state/store'
import { loadGlbJersey, type GlbJersey } from './glbJersey'
import { buildProceduralJersey, type JerseyMesh } from './JerseyGeometry'
import { createJerseyKit, type JerseyKit } from './jerseyTexture'
import { kitTier, kitUrl, type KitMap, type KitTier } from './kitFiles'

/**
 * Jersey meshes for the rack and the modal cloth.
 * Default: the Blender-built garment (public/models/jersey.glb). `?mesh=procedural`
 * forces the procedural mesh, which is also the automatic fallback if the GLB fails.
 */
export interface JerseyAssets {
  source: 'glb' | 'procedural'
  /** Static render mesh for the rack. */
  rack(quality: Quality): JerseyMesh
  /** Lighter rack mesh for jerseys hanging side-on (same UVs, maps and silhouette). */
  rackFar(quality: Quality): JerseyMesh
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
    rackFar() {
      return this.rack('low')
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
    rackFar: () => glb.low,
    cloth: (q) => (q === 'high' ? glb.high : glb.low),
  }
}

let assets: Promise<JerseyAssets> | null = null
/** Loads once; safe to `use()` from any component under a Suspense boundary. */
export function jerseyAssets(): Promise<JerseyAssets> {
  assets ??= track(
    forceProcedural
      ? Promise.resolve(proceduralAssets())
      : loadGlbJersey().then(glbAssets, (err) => {
          console.warn('[jersey] GLB failed to load, using the procedural mesh:', err)
          return proceduralAssets()
        }),
  )
  return assets
}

// --- kit maps ------------------------------------------------------------------------

// Kits ship pre-painted as KTX2 (src/jersey/kitFiles.ts); painting them at runtime is the
// fallback (missing files, or a jersey with official `crestUrl` artwork).
let ktx2: KTX2Loader | null = null
let ktx2Ready!: () => void
const ktx2Gate = new Promise<void>((r) => (ktx2Ready = r))

/** Call once with a renderer: KTX2 transcoding targets whatever formats its GPU supports. */
export function initKitLoader(gl: THREE.WebGLRenderer) {
  if (ktx2) return
  ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(gl)
  ktx2Ready()
}

async function loadBakedKit(j: Jersey, tier: KitTier): Promise<JerseyKit> {
  await ktx2Gate
  const load = async (map: KitMap) => {
    const tex = await ktx2!.loadAsync(kitUrl(j.code, map, tier))
    tex.anisotropy = 8
    tex.colorSpace = map === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace
    return tex
  }
  const [map, bump, rough] = await Promise.all([load('color'), load('height'), load('rough')])
  return { map, bump, rough }
}

async function loadKit(j: Jersey, width: number): Promise<JerseyKit> {
  if (!j.crestUrl) {
    try {
      return await loadBakedKit(j, kitTier(width))
    } catch (err) {
      console.warn(`[jersey] no baked kit for ${j.code}, painting it:`, err)
    }
  }
  return createJerseyKit(j, width)
}

const kits = new Map<string, Promise<JerseyKit>>()
const kitKey = (index: number, width: number) => `${index}@${kitTier(width)}`
/** Kit maps for jersey `index` at colour-atlas width `width` (cached; safe to call early to warm). */
export function jerseyKit(index: number, width: number): Promise<JerseyKit> {
  const key = kitKey(index, width)
  if (!kits.has(key)) kits.set(key, track(loadKit(JERSEYS[index], width)))
  return kits.get(key)!
}

/**
 * Frees the modal-resolution kits (tier `m`, ~10 MB of GPU memory each) except those of
 * the jerseys in `keep`. Rack-tier kits are never freed: the rack always shows them.
 */
export function releaseModalKits(keep: Iterable<number>) {
  const kept = new Set(keep)
  for (const [key, kit] of kits) {
    const [index, tier] = key.split('@')
    if (tier !== 'm' || kept.has(Number(index))) continue
    kits.delete(key)
    void kit.then(
      (k) => [k.map, k.bump, k.rough].forEach((t) => t.dispose()),
      () => {},
    )
  }
}
