import { Suspense, use, useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Environment, Lightformer } from '@react-three/drei'
import * as THREE from 'three'
import { jerseyAssets } from '../jersey/assets'
import { createFabricMaterial } from '../jersey/fabricMaterial'
import type { JerseyKit } from '../jersey/jerseyTexture'
import { RINK_BLUE } from '../scene/Room'
import { rackScreenPose } from '../scene/RackSnapshot'
import { useRack, type ScreenPose } from '../state/store'
import { CLOTH_GRID, ClothJersey, modalPointer } from './ClothJersey'
import type { ClothTarget } from './ClothSolver'

const LOOK = new THREE.Vector3(0, -0.56, 0)
const FIT_W = 1.5
const FIT_H = 1.32
const DRAG_YAW = 0.011 // rad per px when spinning the hanger by dragging the background
const CENTER: ClothTarget = { x: 0, y: 0, z: 0, yaw: 0 }
/** Lift-off / put-back move faster than a carousel step. */
const LIFT_GLIDE = { stiffness: 42, maxAccel: 14 }
const CLOSE_MS = 700

interface Fade {
  value: number
  to: number
  /** Seconds before the fade starts, and how long it takes. */
  delay: number
  duration: number
}

interface Entry {
  key: number
  index: number
  start: ClothTarget
  target: { current: ClothTarget }
  fade: Fade
  /** Spawned at the rack: waits for the cloth to be ready, then lifts off. */
  liftOff: boolean
}

function useFitCamera() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  useEffect(() => {
    const vfov = THREE.MathUtils.degToRad(camera.fov)
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (size.width / size.height))
    const d = Math.max(FIT_H / 2 / Math.tan(vfov / 2), FIT_W / 2 / Math.tan(hfov / 2))
    camera.position.set(0, LOOK.y + 0.06, d)
    camera.lookAt(LOOK)
    camera.updateMatrixWorld()
  }, [camera, size])
}

/** The modal-space hanger pose that lands on the same pixels as a rack pose. */
function fromScreen(pose: ScreenPose, camera: THREE.PerspectiveCamera, height: number): ClothTarget {
  const depth = height / 2 / (pose.pxPerM * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2))
  const forward = camera.getWorldDirection(new THREE.Vector3())
  const dir = new THREE.Vector3(pose.ndcX, pose.ndcY, 0.5).unproject(camera).sub(camera.position).normalize()
  const p = camera.position.clone().addScaledVector(dir, depth / dir.dot(forward))
  return { x: p.x, y: p.y, z: p.z, yaw: pose.yaw }
}

/** Pointer on the jersey plane + velocity, feeding the cloth's wind field. */
function PointerWind() {
  const gl = useThree((s) => s.gl)
  const st = useMemo(() => ({ ray: new THREE.Raycaster(), hit: new THREE.Vector3(), primed: false }), [])
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.05), [])
  useEffect(() => {
    const el = gl.domElement
    const on = () => (modalPointer.on = true)
    const off = () => {
      modalPointer.on = false
      modalPointer.vel.set(0, 0, 0)
    }
    el.addEventListener('pointermove', on)
    el.addEventListener('pointerleave', off)
    return () => {
      el.removeEventListener('pointermove', on)
      el.removeEventListener('pointerleave', off)
      off()
    }
  }, [gl])
  useFrame(({ pointer, camera }, dt) => {
    st.ray.setFromCamera(pointer, camera)
    if (!st.ray.ray.intersectPlane(plane, st.hit)) return
    if (!st.primed) {
      modalPointer.pos.copy(st.hit)
      st.primed = true
    }
    const v = st.hit.clone().sub(modalPointer.pos).divideScalar(Math.max(dt, 1 / 240)).clampLength(0, 3)
    modalPointer.vel.lerp(v, 0.5)
    modalPointer.pos.copy(st.hit)
  })
  return null
}

/** Compiles the cloth shader programs once, up front, so the first open doesn't hitch. */
function ShaderPrewarm() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const quality = useRack((s) => s.quality)
  const assets = use(jerseyAssets())
  useEffect(() => {
    const tiny = () => new THREE.CanvasTexture(document.createElement('canvas'))
    const kit: JerseyKit = { map: tiny(), bump: tiny(), rough: tiny() }
    kit.map.colorSpace = THREE.SRGBColorSpace
    const grid = CLOTH_GRID[quality]
    const source = assets.cloth(quality, grid)
    const mat = createFabricMaterial(kit, { fade: { value: 1 }, maps: source.maps, inside: source.draped ? '#808080' : undefined })
    const mesh = new THREE.Mesh(source.geometry, mat)
    mesh.castShadow = mesh.receiveShadow = true
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    scene.add(mesh)
    gl.compile(scene, camera)
    scene.remove(mesh)
  }, [gl, scene, camera, quality, assets])
  return null
}

export function ModalScene() {
  useFitCamera()
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const quality = useRack((s) => s.quality)
  const [entries, setEntries] = useState<Entry[]>([])
  const keyRef = useRef(0)
  const yaw = useRef({ base: 0, drag: 0 })

  // Choreography, driven by the store's phase / open index.
  useEffect(() => {
    const spawn = (index: number, start: ClothTarget, fade: Fade, liftOff: boolean): Entry => ({
      key: ++keyRef.current,
      index,
      start,
      target: { current: liftOff ? { ...start } : { ...CENTER } },
      fade,
      liftOff,
    })

    return useRack.subscribe((s, prev) => {
      // open: spawn on top of the rack's jersey
      if (s.phase === 'opening' && s.openFrom && !prev.openFrom && s.open !== null) {
        yaw.current = { base: 0, drag: 0 }
        const start = fromScreen(s.openFrom, camera, size.height)
        setEntries([spawn(s.open, start, { value: 1, to: 1, delay: 0, duration: 0.01 }, true)])
      }
      // carousel step: old one drifts up and fades, new one rises from below and fades in
      if (s.phase === 'open' && s.open !== prev.open && s.open !== null && prev.open !== null) {
        yaw.current = { base: 0, drag: 0 }
        const dir = s.stepDir
        setEntries((list) => {
          const old = list[list.length - 1]
          if (old) {
            old.target.current = { ...old.target.current, y: old.target.current.y + 0.08, x: -dir * 0.06 }
            // cross-dissolve: the old one lingers while the new one's cloth spins up
            Object.assign(old.fade, { to: 0, delay: 0.1, duration: 0.32 })
          }
          const start = { x: dir * 0.1, y: -0.3, z: 0, yaw: 0 }
          return [...list.slice(-1), spawn(s.open!, start, { value: 0, to: 1, delay: 0.02, duration: 0.45 }, false)]
        })
      }
      // close: fly back to the rack slot and fade out on arrival
      if (s.phase === 'closing' && prev.phase !== 'closing') {
        setEntries((list) => {
          const active = list[list.length - 1]
          if (!active) return list
          const pose = s.open !== null ? rackScreenPose(s.open) : null
          active.target.current = pose ? { ...fromScreen(pose, camera, size.height), glide: LIFT_GLIDE } : { ...CENTER, y: -0.3 }
          Object.assign(active.fade, { to: 0, delay: CLOSE_MS / 1000 - 0.28, duration: 0.24 })
          return [active]
        })
        window.setTimeout(() => useRack.getState().closed(), CLOSE_MS)
      }
      if (s.phase === 'closed' && prev.phase !== 'closed') setEntries([])
    })
  }, [camera, size])

  // drop departed jerseys once they've faded
  useEffect(() => {
    if (entries.length < 2) return
    const t = window.setTimeout(() => setEntries((list) => list.slice(-1)), 600)
    return () => window.clearTimeout(t)
  }, [entries])

  // Flip button / F key: always spin onward rather than unwinding.
  useEffect(
    () =>
      useRack.subscribe((s, prev) => {
        if (s.flipped === prev.flipped || s.open !== prev.open) return
        const showingBack = Math.round(yaw.current.base / Math.PI) % 2 !== 0
        if (showingBack !== s.flipped) yaw.current.base += Math.PI
      }),
    [],
  )

  useFrame((_, dt) => {
    const phase = useRack.getState().phase
    entries.forEach((e, i) => {
      const f = e.fade
      if (f.delay > 0) f.delay -= dt
      else if (f.value !== f.to) {
        const step = dt / Math.max(f.duration, 1e-3)
        f.value = f.to > f.value ? Math.min(f.to, f.value + step) : Math.max(f.to, f.value - step)
      }
      const active = i === entries.length - 1
      if (active && phase === 'open' && !e.target.current.glide) e.target.current.yaw = yaw.current.base + yaw.current.drag
    })
  })

  const onReady = (e: Entry) => () => {
    if (!e.liftOff) return
    useRack.getState().liftOff()
    e.target.current = { ...CENTER, glide: LIFT_GLIDE }
    // after the lift, hand back to the gentler carousel glide
    window.setTimeout(() => {
      if (e.target.current.glide) e.target.current = { ...CENTER, yaw: yaw.current.base }
    }, 900)
  }

  // Dragging the empty background spins the hanger; it settles on front or back.
  const onBackgroundDown = (e: ThreeEvent<PointerEvent>) => {
    if (useRack.getState().phase !== 'open') return
    const x0 = e.nativeEvent.clientX
    gl.domElement.style.cursor = 'ew-resize'
    const move = (ev: PointerEvent) => (yaw.current.drag = (ev.clientX - x0) * DRAG_YAW)
    const up = () => {
      const snapped = Math.round((yaw.current.base + yaw.current.drag) / Math.PI) * Math.PI
      yaw.current = { base: snapped, drag: 0 }
      const back = Math.abs(Math.round(snapped / Math.PI)) % 2 === 1
      if (useRack.getState().flipped !== back) useRack.setState({ flipped: back })
      gl.domElement.style.cursor = ''
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const active = entries[entries.length - 1]

  return (
    <>
      <Environment resolution={256} frames={1} environmentIntensity={0.55}>
        <Lightformer intensity={2} position={[0, 3, 3]} scale={[5, 2, 1]} />
        <Lightformer intensity={0.6} position={[-4, 0, 2]} rotation-y={Math.PI / 2} scale={[3, 2, 1]} />
        <Lightformer intensity={2.2} color={RINK_BLUE} position={[0, 0, -3]} scale={[6, 1, 1]} />
      </Environment>
      <hemisphereLight args={['#dfe8ff', '#14171b', 0.18]} />
      {/* key: high and to the side so sleeves, collar and folds cast real shadows */}
      <directionalLight
        position={[-1.4, 2.4, 2.2]}
        intensity={2.9}
        castShadow
        shadow-mapSize={quality === 'high' ? [2048, 2048] : [1024, 1024]}
        shadow-radius={4}
        shadow-bias={-0.0002}
        shadow-normalBias={0.006}
        shadow-camera-left={-0.9}
        shadow-camera-right={0.9}
        shadow-camera-top={0.4}
        shadow-camera-bottom={-1.3}
        shadow-camera-near={0.5}
        shadow-camera-far={7}
      />
      <directionalLight position={[2, 0.2, 1.5]} intensity={0.45} color="#e8eeff" />
      <directionalLight position={[0.5, 0.6, -2.5]} intensity={2.4} color={RINK_BLUE} />
      <PointerWind />
      <Suspense fallback={null}>
        <ShaderPrewarm />
      </Suspense>

      {/* catches background drags (behind the jersey, so cloth hits win) */}
      <mesh position={[0, -0.5, -0.6]} onPointerDown={onBackgroundDown}>
        <planeGeometry args={[20, 20]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <Suspense fallback={null}>
        {entries.map((e) => (
          <ClothJersey
            key={e.key}
            index={e.index}
            start={e.start}
            target={e.target}
            fade={e.fade}
            interactive={e === active}
            onReady={onReady(e)}
          />
        ))}
      </Suspense>
    </>
  )
}
