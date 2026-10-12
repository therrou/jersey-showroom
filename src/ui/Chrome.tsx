import { AnimatePresence, motion } from 'motion/react'
import { JERSEYS } from '../data/jerseys'
import { useRack } from '../state/store'

const TICKER = ['NEW KITS DAILY', 'SUBSCRIBE TO OUR NEWSLETTER', 'NATIONAL KITS 2026', 'FREE NAME & NUMBER']

export function Chrome() {
  const hovered = useRack((s) => s.hovered)
  const phase = useRack((s) => s.phase)
  const jersey = hovered !== null ? JERSEYS[hovered] : null
  const items = Array.from({ length: 6 }, () => TICKER).flat()

  return (
    <div className="chrome" data-hidden={phase !== 'closed'}>
      <header className="chrome__top">
        <a href="#about">About</a>
        <div className="logo">
          Kit<span>Room</span>
        </div>
        <a href="#contact">Contact</a>
      </header>

      <div className="caption" aria-live="polite">
        <AnimatePresence mode="wait">
          {jersey && (
            <motion.span
              key={jersey.code}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            >
              {jersey.title}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <button className="pill chrome__cta" type="button">
        See availability
      </button>

      <div className="ticker" aria-hidden>
        <div className="ticker__track">
          {items.map((t, i) => (
            <span key={i}>
              {t}
              <i>•</i>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
