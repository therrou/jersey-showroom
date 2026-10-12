import { useEffect, useState } from 'react'
import { useLoading } from '../state/loading'

/** Full-screen loading screen until the rack has drawn its first frames with every
 *  jersey (GLB + all kits painted). Fades out, then unmounts. */
export function Loader() {
  const { started, done, ready } = useLoading()
  const [gone, setGone] = useState(false)
  useEffect(() => {
    if (!ready) return
    const t = window.setTimeout(() => setGone(true), 600)
    return () => window.clearTimeout(t)
  }, [ready])
  if (gone) return null
  // the last stretch (shader compile, first frames) is the final 10%
  const progress = ready ? 1 : started ? (done / started) * 0.9 : 0.04
  return (
    <div className="loader" data-ready={ready} role="status" aria-live="polite" aria-busy={!ready}>
      <div className="loader__logo">
        showroom<span>-jersey</span>
      </div>
      <div className="loader__bar">
        <div className="loader__fill" style={{ transform: `scaleX(${progress})` }} />
      </div>
      <div className="loader__label">{ready ? 'Ready' : 'Loading jerseys…'}</div>
    </div>
  )
}
