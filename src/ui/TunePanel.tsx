import { Leva, useControls, folder } from 'leva'
import { physics } from '../config/physics'

const enabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('tune')

/** Live physics tuning (open the app with ?tune). Writes straight into `physics`. */
function Controls() {
  const set = <K extends keyof typeof physics>(group: K, key: string) => (v: number) => {
    ;(physics[group] as Record<string, number>)[key] = v
  }
  useControls({
    motion: { value: physics.motion, min: 0, max: 2, step: 0.05, label: 'motion (master)', onChange: (v: number) => (physics.motion = v) },
    rack: folder({
      slideStiffness: { value: physics.rack.slideStiffness, min: 5, max: 80, onChange: set('rack', 'slideStiffness') },
      slideDamping: { value: physics.rack.slideDamping, min: 0.3, max: 2, onChange: set('rack', 'slideDamping') },
      turnStiffness: { value: physics.rack.turnStiffness, min: 0.1, max: 2, onChange: set('rack', 'turnStiffness') },
      turnDamping: { value: physics.rack.turnDamping, min: 0.3, max: 2, onChange: set('rack', 'turnDamping') },
      swingDrag: { value: physics.rack.swingDrag, min: 0.2, max: 6, onChange: set('rack', 'swingDrag') },
      brushGain: { value: physics.rack.brushGain, min: 0, max: 0.03, step: 0.001, onChange: set('rack', 'brushGain') },
    }),
    'rack cloth': folder({
      lagGain: { value: physics.rackCloth.lagGain, min: 0, max: 3, onChange: set('rackCloth', 'lagGain') },
      twistGain: { value: physics.rackCloth.twistGain, min: 0, max: 1.5, onChange: set('rackCloth', 'twistGain') },
      ripple: { value: physics.rackCloth.ripple, min: 0, max: 2, onChange: set('rackCloth', 'ripple') },
      flare: { value: physics.rackCloth.flare, min: 0, max: 2, onChange: set('rackCloth', 'flare') },
    }),
    modal: folder({
      glideMaxAccel: { value: physics.modal.glideMaxAccel, min: 1, max: 12, onChange: set('modal', 'glideMaxAccel') },
      swingDamping: { value: physics.modal.swingDamping, min: 0.5, max: 10, onChange: set('modal', 'swingDamping') },
      flipStiffness: { value: physics.modal.flipStiffness, min: 2, max: 40, onChange: set('modal', 'flipStiffness') },
      flipDamping: { value: physics.modal.flipDamping, min: 0.2, max: 1.5, onChange: set('modal', 'flipDamping') },
      wind: { value: physics.modal.wind, min: 0, max: 3, onChange: set('modal', 'wind') },
      bendCompliance: { value: physics.modal.bendCompliance, min: 1e-5, max: 5e-3, step: 1e-5, onChange: set('modal', 'bendCompliance') },
    }),
  })
  return null
}

export function TunePanel() {
  if (!enabled) return null
  return (
    <>
      <Leva collapsed={false} titleBar={{ title: 'physics' }} />
      <Controls />
    </>
  )
}
