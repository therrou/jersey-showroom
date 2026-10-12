import { useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { AnimatePresence, motion, type Variants } from 'motion/react'
import * as THREE from 'three'
import { JERSEYS } from '../data/jerseys'
import { modalKitWidth } from '../cloth/ClothJersey'
import { ModalScene } from '../cloth/ModalScene'
import { handoff } from '../state/handoff'
import { jerseyKit, releaseModalKits } from '../jersey/assets'
import { useBackdrop } from '../scene/RackSnapshot'
import { useRack } from '../state/store'

const EASE = [0.23, 1, 0.32, 1] as const
/** How long the modal copy takes to dissolve into the rack's once both are on screen. */
const HANDOFF_FADE_MS = 140
/** Modal kits leave memory this long after they stop being needed (outlasts the carousel
 *  cross-fade and the put-back clear-up, so nothing on screen loses its textures). */
const RELEASE_KITS_MS = 2000

/** Blurred still of the rack (captured once by RackSnapshot) — a cheap, compositor-only fade. */
function Backdrop() {
  const canvas = useBackdrop((s) => s.canvas)
  const phase = useRack((s) => s.phase)
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current
    if (!el || !canvas) return
    canvas.className = 'backdrop__img'
    el.replaceChildren(canvas)
  }, [canvas])
  useEffect(() => {
    if (phase === 'closed') useBackdrop.setState({ canvas: null })
  }, [phase])
  // (the hide direction has a CSS delay: the jersey flies back over the blur and the
  // rack sharpens just as it lands)
  const shown = !!canvas && (phase === 'open' || phase === 'opening')
  return <div ref={host} className="backdrop" data-shown={shown} aria-hidden />
}

const ui: Variants = {
  hidden: { opacity: 0, y: 12 },
  shown: (i: number) => ({ opacity: 1, y: 0, transition: { delay: 0.12 + i * 0.05, duration: 0.42, ease: EASE } }),
  exit: { opacity: 0, y: 6, transition: { duration: 0.18, ease: EASE } },
}

function ModalUI() {
  const open = useRack((s) => s.open)
  const flipped = useRack((s) => s.flipped)
  const [hint, setHint] = useState(true)
  if (open === null) return null
  const jersey = JERSEYS[open]
  const counter = `${String(open + 1).padStart(2, '0')} / ${String(JERSEYS.length).padStart(2, '0')}`
  const coarse = matchMedia('(pointer: coarse)').matches

  return (
    <motion.div className="modal__ui" initial="hidden" animate="shown" exit="exit" onPointerDown={() => setHint(false)}>
      <motion.button variants={ui} custom={0} className="modal__close" type="button" onClick={() => useRack.getState().close()}>
        Close
      </motion.button>
      <motion.button
        variants={ui}
        custom={2}
        className="modal__arrow modal__arrow--prev"
        type="button"
        aria-label="Previous jersey"
        onClick={() => useRack.getState().step(-1)}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M15 5l-7 7 7 7" />
        </svg>
      </motion.button>
      <motion.button
        variants={ui}
        custom={2}
        className="modal__arrow modal__arrow--next"
        type="button"
        aria-label="Next jersey"
        onClick={() => useRack.getState().step(1)}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M9 5l7 7-7 7" />
        </svg>
      </motion.button>

      <div className="modal__info">
        <motion.div variants={ui} custom={1} className="modal__counter">
          {counter}
        </motion.div>
        <motion.div variants={ui} custom={2} className="modal__title-wrap">
          <AnimatePresence mode="wait" initial={false}>
            <motion.h2
              key={jersey.code}
              className="modal__title"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0, transition: { delay: 0.1, duration: 0.4, ease: EASE } }}
              exit={{ opacity: 0, y: -8, transition: { duration: 0.16, ease: EASE } }}
            >
              {jersey.title}
            </motion.h2>
          </AnimatePresence>
        </motion.div>
        <motion.div variants={ui} custom={3} className="modal__actions">
          <button className="pill" type="button" onClick={() => useRack.getState().toggleFlip()}>
            {flipped ? 'View front' : 'View back'}
          </button>
        </motion.div>
      </div>

      <AnimatePresence>
        {hint && (
          <motion.p
            className="modal__hint"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: 1.2, duration: 0.4 } }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
          >
            {coarse ? 'Pull the fabric · swipe beside it to turn' : 'Grab the fabric · drag the background to turn it'}
          </motion.p>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export function JerseyModal() {
  const phase = useRack((s) => s.phase)
  const open = useRack((s) => s.open)
  const hovered = useRack((s) => s.hovered)
  const quality = useRack((s) => s.quality)
  const dpr = useRack((s) => s.dpr)

  // Warm the modal's 4K kit for whatever the user is lingering on, and for the neighbours
  // of the open jersey, so opening and ←/→ never wait on texture painting.
  useEffect(() => {
    const i = phase === 'closed' ? hovered : open
    if (i === null) return
    const n = JERSEYS.length
    const width = modalKitWidth(quality)
    const t = window.setTimeout(
      () => {
        void jerseyKit(i, width)
        if (phase !== 'closed') {
          void jerseyKit((i + 1) % n, width)
          void jerseyKit((i - 1 + n) % n, width)
        }
      },
      phase === 'closed' ? 220 : 500,
    )
    return () => window.clearTimeout(t)
  }, [phase, hovered, open, quality])

  // …and free the 4K kits nobody needs any more: only the open jersey and its neighbours
  // (or, on the rack, the one being lingered on) stay resident
  useEffect(() => {
    const keep: number[] = []
    if (quality === 'high') {
      const n = JERSEYS.length
      if (phase === 'closed') {
        if (hovered !== null) keep.push(hovered)
      } else if (open !== null) keep.push(open, (open + 1) % n, (open - 1 + n) % n)
    }
    const t = window.setTimeout(() => releaseModalKits(keep), RELEASE_KITS_MS)
    return () => window.clearTimeout(t)
  }, [phase, hovered, open, quality])

  useEffect(() => {
    if (phase !== 'open') return
    const onKey = (e: KeyboardEvent) => {
      const s = useRack.getState()
      if (e.key === 'Escape') s.close()
      else if (e.key === 'ArrowRight') s.step(1)
      else if (e.key === 'ArrowLeft') s.step(-1)
      else if (e.key.toLowerCase() === 'f') s.toggleFlip()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase])

  // Put-back hand-off: stay up (and rendering) after closing until the rack has drawn
  // its copy under ours, then fade ours out briefly — the swap happens under matching
  // pixels, never a frame with neither copy and never two copies apart.
  const [active, setActive] = useState(false)
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    if (phase !== 'closed') {
      setActive(true)
      setLeaving(false)
      return
    }
    let t = 0
    const cancel = handoff.whenRackDrawn(() => {
      setLeaving(true)
      t = window.setTimeout(() => setActive(false), HANDOFF_FADE_MS)
    })
    return () => {
      cancel()
      window.clearTimeout(t)
    }
  }, [phase])
  return (
    <>
      <Backdrop />
      <div className="modal" data-active={active} role="dialog" aria-modal="true" aria-hidden={!active}>
        <div className="modal__stage" data-leaving={leaving}>
          {/* always mounted: no context creation or shader compile on open */}
          <Canvas
            frameloop={active ? 'always' : 'never'}
            shadows={{ type: THREE.PCFShadowMap }}
            dpr={quality === 'high' ? Math.max(dpr, 1.25) : Math.min(dpr, 1.5)}
            camera={{ fov: 30, position: [0, -0.5, 3], near: 0.1, far: 30 }}
            gl={{ alpha: true, antialias: true, toneMapping: THREE.NeutralToneMapping, toneMappingExposure: 0.95 }}
          >
            <ModalScene />
          </Canvas>
        </div>
        <AnimatePresence>{(phase === 'open' || phase === 'opening') && <ModalUI key="ui" />}</AnimatePresence>
      </div>
    </>
  )
}
