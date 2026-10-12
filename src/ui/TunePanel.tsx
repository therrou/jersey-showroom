import { Leva, useControls, folder } from 'leva'
import { CLOTH_FEEL, physics } from '../config/physics'

const enabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('tune')

/** Live physics tuning (open the app with ?tune). Writes straight into `physics`. */
function Controls() {
  const set = <K extends keyof typeof physics>(group: K, key: string) => (v: number) => {
    ;(physics[group] as Record<string, number>)[key] = v
  }
  // Cloth feel first: the knobs that decide how the modal jersey grabs and settles.
  const feelKeys = ['grabStrength', 'grabRadius', 'grabMaxPull', 'damping', 'releaseDamping', 'volumeCompliance'] as const
  const [, setFeel] = useControls('cloth feel', () => ({
    preset: {
      options: Object.keys(CLOTH_FEEL),
      value: 'default',
      onChange: (name: string) => {
        const p = CLOTH_FEEL[name]
        if (!p) return
        Object.assign(physics.modal, p)
        setFeel(Object.fromEntries(feelKeys.map((k) => [k, p[k]])))
      },
    },
    grabStrength: { value: physics.modal.grabStrength, min: 0.02, max: 0.6, label: 'grab strength', onChange: set('modal', 'grabStrength') },
    grabRadius: { value: physics.modal.grabRadius, min: 0.02, max: 0.12, label: 'grab radius (m)', onChange: set('modal', 'grabRadius') },
    grabMaxPull: { value: physics.modal.grabMaxPull, min: 0.03, max: 0.4, label: 'max pull (m)', onChange: set('modal', 'grabMaxPull') },
    damping: { value: physics.modal.damping, min: 0.2, max: 6, label: 'damping', onChange: set('modal', 'damping') },
    releaseDamping: { value: physics.modal.releaseDamping, min: 0, max: 20, label: 'calm after drop', onChange: set('modal', 'releaseDamping') },
    volumeCompliance: { value: physics.modal.volumeCompliance, min: 1e-3, max: 4e-2, step: 1e-3, label: 'volume softness', onChange: set('modal', 'volumeCompliance') },
  }))
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
