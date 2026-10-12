# Kit Room — hockey jersey rack POC

React Three Fiber recreation of a "garments on a rail" product browser, with national-team
hockey jerseys (IIHF top 10, inspired-by kits) and physics as the point.

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm build
```

Open with `?tune` for a live physics panel (master **motion** dial + per-system knobs);
defaults live in `src/config/physics.ts`.

## How it works

**Rack (hybrid physics, Rapier @ 120 Hz)**
- Each jersey = a *trolley* body locked to the rail's x axis + a *hanger* body on a spherical
  joint (free swing and yaw). Trolleys are spring-pulled to layout slots; a torsional spring
  at the hook turns the hovered jersey to face you (`src/scene/HangerRig.tsx`).
- Jerseys collide with each other. The cursor is a *brush*: when it's inside a jersey's
  fabric it applies a capped contact impulse at that point from its velocity relative to the
  cloth, so sweeps set jerseys swinging and twisting without ever launching them.
- Fabric motion on the rack is faked in a vertex shader driven by the hanger's measured
  motion: hem inertia lag, trailing twist on turns, sleeve flare, speed ripples, static drape
  folds (`src/jersey/fabricMaterial.ts`).
- Hover is picked by rail position (nearest hanger, turned-out one holds its width) rather than
  raycasting slivers, so it never flickers (`src/scene/RackHover.tsx`).

**Modal (real cloth, Web Worker)**
- XPBD cloth, "small steps" (12 substeps × 1 pass desktop, 8 on phones): stretch/shear,
  bending across every interior edge (remembering a drape-folded rest shape), front↔back volume constraints, per-triangle aerodynamic drag, pinned to a
  simulated hanger (critically damped pivot glide + pendulum swing + yaw spring)
  (`src/cloth/ClothSolver.ts`).
- Grab-and-pull a soft patch of fabric; drag the background (or "View back" / `F`) to turn it.
  Pointer movement near the jersey stirs a local wind field.

**Jersey geometry** — `JerseyMesh` interface (`src/jersey/JerseyGeometry.ts`). Default: a
garment built in Blender (`public/models/jersey.glb`, pipeline in `tools/blender/`): a
draped render mesh (~24k tris desktop / ~6.7k phones) with baked normal + AO maps, bound to
a simulation cage (~2.5k / ~1.2k particles, welded tube, pins where it rests on the
hanger). Each render vertex rides on a cage triangle (barycentric + normal offset) and is
rebuilt after every solver step (`src/jersey/skin.ts`); the rack shows the render mesh
directly. `?mesh=procedural` switches to the procedural fallback (flat pattern inflated
into two layers), which also kicks in automatically if the GLB fails to load.

**Kit art + material** — `src/jersey/jerseyTexture.ts` paints three aligned maps per jersey
from `src/data/jerseys.ts`: colour, height (raised tackle-twill lettering with stitched edges,
rib knit, perforated vent panels, seams) and roughness (glossier twill on matte knit).
`src/jersey/fabricMaterial.ts` combines that bump with a tiled knit micro-relief, applies the
baked AO, and adds sheen. Set `crestUrl` on a jersey to use official chest artwork.

**Modal transition** — the jersey lifts off the rack: the rack publishes the jersey's screen
pose, the cloth spawns at exactly those pixels and glides to centre; the rack captures one
frame (with that jersey hidden), blurs it once into a still backdrop and stops rendering.
Closing flies the jersey back to its slot. ←/→ cross-dissolve: the old jersey drifts up and
fades, the next rises from below and fades in. Kits for the hovered jersey and the open
jersey's neighbours are painted ahead of time.

**Modal cloth feel** — `?tune` → *grab & drop*: presets (heavy knit / default / light
jersey) and every knob that shapes the grab and the settle — grab strength / radius / max
pull / falloff, damping, calm after drop (+ how long), speed cap, air drag, bend / stretch /
volume softness, hanger swing damping. All live; **copy settings** puts the current values
on the clipboard as JSON (defaults live in `src/config/physics.ts`, `CLOTH_FEEL`).

`?fps` shows a frame-rate overlay (handy on a real phone with `pnpm dev --host`).

> **TODO (follow-up):** real cut-out vent holes — alpha-tested perforations on the vent
> panels (a mask channel from the kit painter + a custom depth material for shadows), so
> you can see through to the inside of the tube.

## Quality tiers
Phones / coarse pointers / narrow screens start on `low` (smaller cloth grid, 1K/2K textures,
no post-processing, plain floor). On desktop the render scale adapts first (1×–1.5×), and only
if that isn't enough does it drop to `low` (drei `PerformanceMonitor`, started after load).
Portrait screens frame part of the rail and pan by swipe; tap to turn a jersey out, tap again
to open.
