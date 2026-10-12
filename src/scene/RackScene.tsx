import { Suspense, useEffect, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PerformanceMonitor } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import * as THREE from 'three'
import { JERSEYS } from '../data/jerseys'
import { initKitLoader } from '../jersey/assets'
import { useLoading } from '../state/loading'
import { useRack } from '../state/store'
import { CursorTracker } from './CursorTracker'
import { RackHover } from './RackHover'
import { HangerRig } from './HangerRig'
import { hangerX, rackView } from './RackHover'
import { RAIL_LENGTH, slotPositions } from './rackLayout'
import { RackSnapshot } from './RackSnapshot'
import { Room } from './Room'

const HOME = slotPositions(JERSEYS.length, null)
// What must stay in frame: the rail with one jersey turned out, rail to floor.
const FRAME_W = 2.75
const FRAME_H = 1.55
/** Portrait screens frame a stretch of rail and pan along it. */
const FRAME_W_PORTRAIT = 1.35
const LOOK_AT = new THREE.Vector3(0, 0.4, 0)
/** Camera stays put this long after the modal closes (covers the hand-off fade). */
const HOLD_AFTER_CLOSE_MS = 450

/**
 * Fits the rack to the viewport. Landscape: whole rack + a little pointer parallax.
 * Portrait: a stretch of rail, panned by swipe and eased onto the tapped jersey.
 */
function CameraRig() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const dist = useRef(4)
  const look = useRef(LOOK_AT.clone())
  const holdUntil = useRef(0)
  useEffect(() => {
    const vfov = THREE.MathUtils.degToRad(camera.fov)
    const aspect = size.width / size.height
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect)
    rackView.portrait = aspect < 1
    const w = rackView.portrait ? FRAME_W_PORTRAIT : FRAME_W
    dist.current = Math.max(FRAME_H / 2 / Math.tan(vfov / 2), w / 2 / Math.tan(hfov / 2)) + 0.15
    rackView.panLimit = rackView.portrait ? Math.max(0, RAIL_LENGTH / 2 - w / 2 + 0.1) : 0
  }, [camera, size])
  useFrame(({ pointer }, dt) => {
    // Hold still from lift-off until shortly after the put-back hand-off: the modal copy
    // is placed by this camera's pixels, so parallax must not slide the rack under it.
    const now = performance.now()
    if (useRack.getState().phase !== 'closed') holdUntil.current = now + HOLD_AFTER_CLOSE_MS
    if (now < holdUntil.current) return
    const k = 1 - Math.exp(-dt * 3)
    let x = pointer.x * 0.12
    if (rackView.portrait) {
      const hovered = useRack.getState().hovered
      if (hovered !== null && !rackView.dragging) rackView.pan = hangerX[hovered] ?? rackView.pan
      rackView.pan = THREE.MathUtils.clamp(rackView.pan, -rackView.panLimit, rackView.panLimit)
      x = rackView.pan
    }
    camera.position.x += (x - camera.position.x) * (rackView.dragging ? 1 - Math.exp(-dt * 20) : k)
    camera.position.y += (LOOK_AT.y + 0.08 + (rackView.portrait ? 0 : pointer.y * 0.05) - camera.position.y) * k
    camera.position.z += (dist.current - camera.position.z) * k
    look.current.x = rackView.portrait ? camera.position.x : LOOK_AT.x
    camera.lookAt(look.current)
  })
  return null
}

/** Mounts with the jerseys: once the rack has drawn a couple of frames with all of them
 *  (shaders compiled, textures uploaded), the loading screen can go. */
function ReadySignal() {
  const frames = useRef(0)
  useFrame(() => {
    if (++frames.current === 3) useLoading.getState().setReady()
  })
  return null
}

/** Mounts once everything above it in the Suspense boundary has resolved. */
function Loaded({ onLoad }: { onLoad: () => void }) {
  useEffect(() => {
    // give shader compiles and texture uploads a moment before judging the frame rate
    const t = window.setTimeout(onLoad, 2500)
    return () => window.clearTimeout(t)
    // fire once per mount, whatever the parent re-renders do to the callback identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

export function RackScene() {
  // kit textures are GPU-compressed (KTX2): the loader needs a renderer to pick formats
  initKitLoader(useThree((s) => s.gl))
  const quality = useRack((s) => s.quality)
  const phase = useRack((s) => s.phase)
  const [settled, setSettled] = useState(false)
  return (
    <>
      {settled && phase === 'closed' && (
        <PerformanceMonitor
          iterations={6}
          // resolution first: 1× … 1.5× (capped by the screen)
          onChange={({ factor }) =>
            useRack.getState().setDpr(Math.min(window.devicePixelRatio, Math.round((1 + 0.5 * factor) * 10) / 10))
          }
          // still struggling at the bottom of the range: lighter tier
          onFallback={() => useRack.getState().setQuality('low')}
          flipflops={3}
        />
      )}
      <color attach="background" args={['#15181c']} />
      <fog attach="fog" args={['#15181c', 6, 14]} />
      <CameraRig />
      <CursorTracker />
      <RackSnapshot />
      <RackHover />
      <Room />
      <Suspense fallback={null}>
        <Physics timeStep={1 / 120} interpolate gravity={[0, -9.81, 0]} numSolverIterations={8} paused={phase === 'open' || phase === 'opening'}>
          {JERSEYS.map((j, i) => (
            <HangerRig key={j.code} index={i} homeX={HOME[i]} />
          ))}
          <Loaded onLoad={() => setSettled(true)} />
          <ReadySignal />
        </Physics>
      </Suspense>
      {quality === 'high' && (
        <EffectComposer multisampling={0}>
          <N8AO aoRadius={0.22} intensity={2.6} distanceFalloff={0.5} aoSamples={12} denoiseSamples={6} halfRes />
          <Bloom luminanceThreshold={0.95} intensity={0.45} mipmapBlur />
          {/* the composer bypasses the renderer's tone mapping, so apply it here (matches the modal) */}
          <ToneMapping mode={ToneMappingMode.NEUTRAL} />
          <Vignette offset={0.25} darkness={0.55} />
          <SMAA />
        </EffectComposer>
      )}
    </>
  )
}
