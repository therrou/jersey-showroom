import { useEffect, useRef } from 'react'
import { addAfterEffect, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { create } from 'zustand'
import { handoff } from '../state/handoff'
import { useRack, type ScreenPose } from '../state/store'
import { hangerX, hangerYaw } from './RackHover'
import { RAIL_Y } from './rackLayout'

/** The blurred, dimmed still of the rack shown behind the modal. */
export const useBackdrop = create<{ canvas: HTMLCanvasElement | null }>(() => ({ canvas: null }))

let rackCamera: THREE.PerspectiveCamera | null = null
let rackSize = { width: 1, height: 1 }

/** Where hanger `i` sits on screen right now (pivot NDC, px per metre, yaw). */
export function rackScreenPose(i: number): ScreenPose | null {
  const cam = rackCamera
  if (!cam || hangerX[i] === undefined) return null
  const pivot = new THREE.Vector3(hangerX[i], RAIL_Y, 0)
  const forward = cam.getWorldDirection(new THREE.Vector3())
  const depth = pivot.clone().sub(cam.position).dot(forward)
  const ndc = pivot.clone().project(cam)
  const pxPerM = rackSize.height / 2 / (depth * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2))
  return { ndcX: ndc.x, ndcY: ndc.y, pxPerM, yaw: hangerYaw[i] ?? 0 }
}

/** Blurs a frame cheaply: downscale with a canvas filter, the browser upscales it smoothly. */
function blurredCopy(source: HTMLCanvasElement, cssW: number, cssH: number) {
  const scale = 1 / 6
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(cssW * scale))
  c.height = Math.max(1, Math.round(cssH * scale))
  const ctx = c.getContext('2d')!
  ctx.filter = 'blur(2.5px) brightness(0.62) saturate(0.85)'
  ctx.drawImage(source, 0, 0, c.width, c.height)
  return c
}

/**
 * Rack side of the modal transition:
 *  opening → publish the jersey's screen pose (the modal cloth spawns exactly there);
 *            once the modal hides the rack's copy, grab the next rendered frame,
 *            blur it once, and hand over (the rack then stops rendering)
 *  closing → render one frame so the rack shows the right jersey hidden for the put-back
 *  closed  → once a frame with the jersey back on the rail has been drawn, tell the
 *            modal it can let its copy go (src/state/handoff.ts)
 */
export function RackSnapshot() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)

  // frames rendered by this canvas since the jersey came back (-1 = not counting)
  const sinceBack = useRef(-1)
  useEffect(
    () =>
      useRack.subscribe((s, prev) => {
        if (s.phase === 'closed' && prev.phase !== 'closed') sinceBack.current = 0
      }),
    [],
  )
  useFrame(() => {
    // this callback runs before each render: on the second one since 'closed', a frame
    // with the jersey visible has already reached the screen
    if (sinceBack.current < 0) return
    if (++sinceBack.current >= 2) {
      sinceBack.current = -1
      handoff.rackDrawn()
    }
  })

  useEffect(() => {
    rackCamera = camera
    rackSize = { width: size.width, height: size.height }
  }, [camera, size])

  useEffect(
    () =>
      useRack.subscribe((s, prev) => {
        if (s.phase === 'opening' && prev.phase !== 'opening' && s.open !== null) {
          useRack.setState({ openFrom: rackScreenPose(s.open) })
        }
        if (s.phase === 'opening' && s.lifted !== null && prev.lifted === null) {
          // the frame after this one has the jersey hidden: capture it
          let frames = 0
          const off = addAfterEffect(() => {
            if (++frames < 2) return
            off()
            useBackdrop.setState({ canvas: blurredCopy(gl.domElement, size.width, size.height) })
            useRack.getState().opened()
          })
        }
        if (s.phase === 'closing' && prev.phase !== 'closing') invalidate()
        if (s.lifted !== prev.lifted && s.phase !== 'closed') invalidate()
      }),
    [gl, size, invalidate],
  )
  return null
}
