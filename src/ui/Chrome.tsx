import type { CSSProperties } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { JERSEYS } from '../data/jerseys'
import { useRack } from '../state/store'

const TICKER = ['THIS IS A POC, IT CAN BE UPDATED']

/** Dark or light ticker text, whichever reads on `hex`. */
function inkOn(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return L > 0.25 ? '#06121c' : '#f4f7fa'
}

export function Chrome() {
  const hovered = useRack((s) => s.hovered)
  const phase = useRack((s) => s.phase)
  const open = useRack((s) => s.open)
  const jersey = hovered !== null ? JERSEYS[hovered] : null
  const items = Array.from({ length: 16 }, () => TICKER).flat()
  // the banner stays up over the modal, in the open jersey's main colour
  const kit = open !== null && phase !== 'closing' && phase !== 'closed' ? JERSEYS[open].base : null
  const tickerStyle = kit ? ({ '--ticker-bg': kit, '--ticker-ink': inkOn(kit) } as CSSProperties) : undefined

  return (
    <>
      <div className="chrome" data-hidden={phase !== 'closed'}>
        <header className="chrome__top">
          <div className="logo">
            POC<span>-Jersey</span>
          </div>
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
      </div>
      <div className="ticker" style={tickerStyle} aria-hidden>
        <div className="ticker__track">
          {items.map((t, i) => (
            <span key={i}>
              {t}
              <i>•</i>
            </span>
          ))}
        </div>
      </div>
    </>
  )
}
