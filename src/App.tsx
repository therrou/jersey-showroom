import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import { RackScene } from './scene/RackScene'
import { Chrome } from './ui/Chrome'
import { JerseyModal } from './ui/JerseyModal'
import { TunePanel } from './ui/TunePanel'
import { useRack } from './state/store'

export function App() {
  const phase = useRack((s) => s.phase)
  const quality = useRack((s) => s.quality)
  const dpr = useRack((s) => s.dpr)
  // While the modal is up the rack only renders on demand (one frame for the put-back);
  // the blurred backdrop is a still, so the GPU is free for the cloth.
  const frameloop = phase === 'closed' || phase === 'opening' ? 'always' : 'demand'
  return (
    <main className="app">
      <div className="rack">
        <Canvas
          shadows={{ type: THREE.PCFSoftShadowMap }}
          dpr={quality === 'high' ? dpr : Math.min(dpr, 1.25)}
          frameloop={frameloop}
          camera={{ fov: 30, position: [0, 0.45, 4.2], near: 0.1, far: 30 }}
          gl={{
            antialias: quality === 'low',
            toneMapping: THREE.NeutralToneMapping,
            toneMappingExposure: 0.95,
            powerPreference: 'high-performance',
          }}
        >
          <RackScene />
        </Canvas>
      </div>
      <Chrome />
      <JerseyModal />
      <TunePanel />
    </main>
  )
}
