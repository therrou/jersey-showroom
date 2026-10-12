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
import { RAIL_LENGTH, RAIL_Y, slotPositions } from './rackLayout'
import { RackSnapshot } from './RackSnapshot'
import { FLOOR_Y, Room } from './Room'

const HOME = slotPositions(JERSEYS.length, null)
// What must stay in frame: the rail with one jersey turned out, rail to floor.
const FRAME_W = 2.75
const FRAME_H = 1.55
/** Portrait screens frame a stretch of rail and pan along it, fitting this band (at the
 *  rail's plane) above the ticker: from over the LED strip down to the kick plate, so the
 *  ice floor stays out of frame. */
const PORTRAIT_TOP = RAIL_Y + 0.42
const PORTRAIT_BOTTOM = FLOOR_Y + 0.2
/** Narrowest stretch of rail a portrait screen shows (a turned-out jersey + neighbours). */
const PORTRAIT_MIN_W = 0.8
/** Height of the ticker banner (styles.css), which covers the bottom of the canvas. */
const TICKER_PX = 30
const LOOK_AT = new THREE.Vector3(0, 0.4, 0)
/** Camera stays put this long after the modal closes (covers the hand-off fade). */
const HOLD_AFTER_CLOSE_MS = 450

/**
 * Fits the rack to the viewport. Landscape: whole rack + a little pointer parallax.
 * Portrait: a stretch of rail, eased onto the carousel's active jersey.
 */
function CameraRig() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const dist = useRef(4)
  const height = useRef(LOOK_AT.y + 0.08)
  const look = useRef(LOOK_AT.clone())
  const holdUntil = useRef(0)
  useEffect(() => {
    const vfov = THREE.MathUtils.degToRad(camera.fov)
    const aspect = size.width / size.height
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect)
    rackView.portrait = aspect < 1
    let w = FRAME_W
    if (rackView.portrait) {
      // fill the screen height: the visible band (above the ticker) spans top → bottom,
      // looking straight ahead, unless that would crop the rail narrower than the minimum
      const visible = Math.max(0.5, (size.height - TICKER_PX) / size.height)
      const span = PORTRAIT_TOP - PORTRAIT_BOTTOM
      const t = Math.tan(vfov / 2)
      const d = Math.max(span / visible / 2 / t, PORTRAIT_MIN_W / 2 / Math.tan(hfov / 2))
      dist.current = d
      height.current = PORTRAIT_TOP - d * t
      w = 2 * d * Math.tan(hfov / 2)
    } else {
      dist.current = Math.max(FRAME_H / 2 / Math.tan(vfov / 2), w / 2 / Math.tan(hfov / 2)) + 0.15
      height.current = LOOK_AT.y + 0.08
    }
    rackView.panLimit = rackView.portrait ? Math.max(0, RAIL_LENGTH / 2 - w / 2 + 0.1) : 0
    useRack.getState().setCarousel(rackView.portrait)
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
      if (hovered !== null) rackView.pan = hangerX[hovered] ?? rackView.pan
      rackView.pan = THREE.MathUtils.clamp(rackView.pan, -rackView.panLimit, rackView.panLimit)
      x = rackView.pan
    }
    camera.position.x += (x - camera.position.x) * k
    camera.position.y += (height.current + (rackView.portrait ? 0 : pointer.y * 0.05) - camera.position.y) * k
    camera.position.z += (dist.current - camera.position.z) * k
    look.current.x = rackView.portrait ? camera.position.x : LOOK_AT.x
    // portrait looks straight ahead (the fit above assumes it); landscape tilts down a touch
    look.current.y = rackView.portrait ? camera.position.y : LOOK_AT.y
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
  const slowAtMin = useRef(0)
  return (
    <>
      {settled && phase === 'closed' && (
        <PerformanceMonitor
          iterations={8}
          // resolution only, in three coarse steps (1× / 1.25× / 1.5×): every change
          // reallocates the canvas and the effect buffers, which flashes
          step={0.5}
          // resume where it was (it remounts after every modal close)
          factor={THREE.MathUtils.clamp((useRack.getState().dpr - 1) / 0.5, 0, 1)}
          // on a 120 Hz screen anything from 50 fps up is fine; don't chase 60
          bounds={(refresh) => (refresh > 100 ? [50, 100] : [40, 58])}
          onChange={({ factor }) =>
            useRack.getState().setDpr(Math.min(window.devicePixelRatio, 1 + 0.5 * factor))
          }
          // only a genuinely slow machine loses the look (post-processing, reflective
          // floor): still too slow at 1×. drei's own fallback just means "it keeps
          // flip-flopping", so then it simply stops adapting.
          onDecline={({ factor }) => {
            if (factor === 0 && ++slowAtMin.current >= 2) useRack.getState().setQuality('low')
          }}
          flipflops={4}
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
