import { use, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { m, physics } from '../config/physics'
import { JERSEYS } from '../data/jerseys'
import { jerseyAssets, jerseyKit } from '../jersey/assets'
import { mergeSeamNormals } from '../jersey/JerseyGeometry'
import { createFabricMaterial } from '../jersey/fabricMaterial'
import { applySkin, createSkinScratch, pickParticle } from '../jersey/skin'
import { JERSEY_DROP } from '../scene/rackLayout'
import { Hanger } from '../scene/Hanger'
import { useRack } from '../state/store'
import type { ClothInput, ClothTarget } from './ClothSolver'
import type { WorkerIn, WorkerOut } from './cloth.worker'

/** Pointer on the modal's jersey plane, shared by every cloth on screen (wind source). */
export const modalPointer = {
  on: false,
  pos: new THREE.Vector3(),
  vel: new THREE.Vector3(),
}

export const CLOTH_GRID = { high: { cols: 48, rows: 36, substeps: 10 }, low: { cols: 30, rows: 23, substeps: 8 } }
export const modalKitWidth = (q: 'high' | 'low') => (q === 'high' ? 4096 : 2048)
const WIND_RADIUS = 0.24

interface Props {
  index: number
  start: ClothTarget
  target: RefObject<ClothTarget>
  fade: { value: number; to?: number }
  interactive: boolean
  onReady?: () => void
  /** Written every frame: where the simulated hanger actually is (pivot + unwrapped yaw). */
  live?: ClothTarget
}

export function ClothJersey({ index, start, target, fade, interactive, onReady, live }: Props) {
  const quality = useRack((s) => s.quality)
  const grid = CLOTH_GRID[quality]
  const source = use(jerseyAssets()).cloth(quality, grid)
  const kit = use(jerseyKit(index, modalKitWidth(quality)))
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setIndex(source.geometry.getIndex())
    g.setAttribute('uv', source.geometry.getAttribute('uv'))
    if (source.geometry.getAttribute('uv1')) g.setAttribute('uv1', source.geometry.getAttribute('uv1'))
    g.setAttribute('aAO', source.geometry.getAttribute('aAO'))
    if (source.geometry.getAttribute('aCollar')) g.setAttribute('aCollar', source.geometry.getAttribute('aCollar'))
    g.setAttribute('position', source.geometry.getAttribute('position').clone())
    g.setAttribute('normal', source.geometry.getAttribute('normal').clone())
    return g
  }, [source])

  const material = useMemo(
    () => createFabricMaterial(kit, { fade, maps: source.maps, inside: source.draped ? JERSEYS[index].base : undefined }),
    [kit, fade, source, index],
  )
  const skinScratch = useMemo(() => createSkinScratch(source), [source])
  const depthMaterial = useMemo(() => new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), [])
  // Depth-only pre-pass: while the jersey fades, only its front-most surface draws, so
  // the back panel (its lettering) never ghosts through the front.
  const prepass = useMemo(() => new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }), [])

  const hangerRef = useRef<THREE.Group>(null)
  const meshRef = useRef<THREE.Mesh>(null)
  const [ready, setReady] = useState(false)
  const io = useRef({
    worker: null as Worker | null,
    busy: true,
    latest: null as WorkerOut | null,
    spare: null as Float32Array | null,
    grab: null as ClothInput['grab'],
    grabPlane: new THREE.Plane(),
  })

  // Worker lifecycle: build constraints once, settle at the spawn pose, then stream.
  useEffect(() => {
    const worker = new Worker(new URL('./cloth.worker.ts', import.meta.url), { type: 'module' })
    const s = io.current
    s.worker = worker
    s.busy = true
    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      s.latest = e.data
      s.busy = false
    }
    worker.postMessage({
      type: 'init',
      init: {
        particles: source.particles,
        edges: source.edges,
        thickness: source.thickness,
        pins: source.pins,
        triangles: source.triangles,
        pattern: source.pattern,
        draped: source.draped,
        drop: JERSEY_DROP,
        seed: index * 1.37 + 0.31,
        substeps: grid.substeps,
        start,
      },
      cfg: physics.modal,
      // no hidden pre-settle: the cloth starts as the rest drape (exactly the rack's copy)
      // and relaxes into its simulated hang while it lifts off
      settleSteps: 0,
    } satisfies WorkerIn)
    return () => worker.terminate()
    // `start` is the spawn pose only; later moves go through `target`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, grid.substeps])

  useFrame((_, dt) => {
    // Shadows can't fade: a jersey on its way out stops casting at once (it must not
    // darken the next one); one arriving casts from the start, so its self-shadowing
    // fades in with it instead of popping on halfway.
    const casting = (fade.to ?? 1) > 0.5
    if (meshRef.current && meshRef.current.castShadow !== casting) {
      meshRef.current.castShadow = casting
      hangerRef.current?.traverse((o) => ((o as THREE.Mesh).castShadow = casting))
    }
    const s = io.current
    const frame = s.latest
    if (frame?.type === 'idle') {
      // the cloth is asleep: nothing to re-skin, just take the buffer back
      s.latest = null
      if (frame.buffer.length === source.particles.length) s.spare = frame.buffer
    }
    // (a frame from before a quality switch is sized for the other mesh: drop it)
    else if (frame && frame.positions.length !== source.particles.length) s.latest = null
    else if (frame) {
      s.latest = null
      const pos = geometry.getAttribute('position') as THREE.BufferAttribute
      const P = frame.positions
      applySkin(source, P, pos.array as Float32Array, skinScratch)
      pos.needsUpdate = true
      geometry.computeVertexNormals()
      mergeSeamNormals(geometry, source.seamPairs)
      geometry.computeBoundingSphere()
      const q = frame.pose
      hangerRef.current?.position.set(q[0], q[1], q[2])
      hangerRef.current?.quaternion.set(q[3], q[4], q[5], q[6])
      if (live) Object.assign(live, { x: q[0], y: q[1], z: q[2], yaw: q[7] })
      s.spare = P
      if (!ready) {
        setReady(true)
        onReady?.()
      }
    }
    if (!s.busy && s.worker && target.current) {
      const wind = modalPointer.on && interactive && !s.grab
      const g = m(physics.modal.wind)
      const input: ClothInput = {
        dt,
        cfg: physics.modal,
        target: { ...target.current },
        wind: {
          x: modalPointer.pos.x,
          y: modalPointer.pos.y,
          z: modalPointer.pos.z,
          vx: modalPointer.vel.x * g,
          vy: modalPointer.vel.y * g,
          vz: modalPointer.vel.z * g,
          r: WIND_RADIUS,
          on: wind,
        },
        grab: s.grab,
      }
      const buffer = s.spare ?? new Float32Array(source.particles.length)
      s.spare = null
      s.busy = true
      s.worker.postMessage({ type: 'step', input, buffer } satisfies WorkerIn, [buffer.buffer])
    }
  })

  // Grab-and-pull: pick the particle under the pointer, drag it on a camera-facing plane.
  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!interactive || e.face == null) return
    e.stopPropagation()
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute
    let best = e.face.a
    let bestD = Infinity
    for (const v of [e.face.a, e.face.b, e.face.c]) {
      const d = e.point.distanceToSquared(new THREE.Vector3().fromBufferAttribute(pos, v))
      if (d < bestD) {
        bestD = d
        best = v
      }
    }
    const s = io.current
    const normal = camera.getWorldDirection(new THREE.Vector3()).negate()
    s.grabPlane.setFromNormalAndCoplanarPoint(normal, e.point)
    s.grab = { id: pickParticle(source, best), x: e.point.x, y: e.point.y, z: e.point.z }
    gl.domElement.style.cursor = 'grabbing'

    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const hit = new THREE.Vector3()
    const move = (ev: PointerEvent) => {
      const rect = gl.domElement.getBoundingClientRect()
      ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      if (s.grab && ray.ray.intersectPlane(s.grabPlane, hit)) s.grab = { id: s.grab.id, x: hit.x, y: hit.y, z: hit.z }
    }
    const up = () => {
      s.grab = null
      gl.domElement.style.cursor = ''
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <>
      <mesh
        ref={meshRef}
        geometry={geometry}
        material={material}
        customDepthMaterial={depthMaterial}
        castShadow
        receiveShadow
        frustumCulled={false}
        visible={ready}
        onPointerDown={onPointerDown}
        onPointerOver={() => interactive && (gl.domElement.style.cursor = 'grab')}
        onPointerOut={() => !io.current.grab && (gl.domElement.style.cursor = '')}
      />
      <mesh
        geometry={geometry}
        material={prepass}
        frustumCulled={false}
        visible={ready}
        renderOrder={-1}
        raycast={() => null}
        // a faded-out jersey must not keep occluding the next one
        onBeforeRender={() => {
          prepass.depthWrite = material.depthWrite = fade.value > 0.01
        }}
      />
      <group ref={hangerRef} visible={ready}>
        <Hanger fade={fade} />
      </group>
    </>
  )
}
