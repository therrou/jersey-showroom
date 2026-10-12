import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import { RackScene } from './scene/RackScene'
import { Chrome } from './ui/Chrome'
import { JerseyModal } from './ui/JerseyModal'
import { TunePanel } from './ui/TunePanel'
import { FpsOverlay } from './ui/FpsOverlay'
import { Loader } from './ui/Loader'
import { useRack } from './state/store'

export function App() {
  const phase = useRack((s) => s.phase)
  const quality = useRack((s) => s.quality)
  const dpr = useRack((s) => s.dpr)
  // While the modal is up the rack only renders on demand (one frame for the put-back);
  // the blurred backdrop is a still, so the GPU is free for the cloth.
  // the rack also runs while closing: it rearranges live under the fading backdrop
  const frameloop = phase === 'open' ? 'demand' : 'always'
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
      <FpsOverlay />
      <Loader />
    </main>
  )
}
