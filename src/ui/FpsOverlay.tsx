import { useEffect, useRef } from 'react'
import { useRack } from '../state/store'

const enabled = typeof location !== 'undefined' && new URLSearchParams(location.search).has('fps')

/** `?fps`: frame rate, worst frame and quality tier, readable on a phone. */
export function FpsOverlay() {
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!enabled) return
    let raf = 0
    let frames = 0
    let worst = 0
    let last = performance.now()
    let windowStart = last
    const tick = (t: number) => {
      frames++
      worst = Math.max(worst, t - last)
      last = t
      if (t - windowStart >= 1000 && el.current) {
        const fps = (frames * 1000) / (t - windowStart)
        el.current.textContent = `${fps.toFixed(0)} fps · worst ${worst.toFixed(0)} ms · ${useRack.getState().quality}`
        frames = 0
        worst = 0
        windowStart = t
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  if (!enabled) return null
  return (
    <div
      ref={el}
      style={{
        position: 'fixed',
        left: 8,
        bottom: 40,
        zIndex: 100,
        padding: '4px 8px',
        font: '12px/1.4 ui-monospace, monospace',
        color: '#fff',
        background: 'rgba(0,0,0,0.6)',
        borderRadius: 4,
        pointerEvents: 'none',
      }}
    >
      …
    </div>
  )
}
