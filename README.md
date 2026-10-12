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
  folds (`src/jersey/fabricMaterial.ts`). Each jersey also hangs differently: it blends
  drape variants baked in Blender (morph targets, `tools/blender/variants.py`), and on top
  its sleeves swing/splay about the shoulder (`src/jersey/sleeves.ts`), the hem tilts,
  opens and turns, the folds deepen or soften (seeded; `src/jersey/variety.ts`). The modal's
  cloth starts from (and rests in) exactly that shape, so it never reshapes on the way.
- Hover is picked by rail position (nearest hanger, turned-out one holds its width) rather than
  raycasting slivers, so it never flickers (`src/scene/RackHover.tsx`).

**Modal (real cloth, Web Worker)**
- XPBD cloth, "small steps" (10 substeps × 1 pass desktop, 8 on phones) at a fixed 60 Hz,
  interpolated for display; it sleeps once still (no solver or skinning work) and wakes on a
  grab, the pointer wind or a move. Stretch stiff in
  tension / soft in compression (resting on the flat pattern), signed dihedral bending
  resting near flat (seams keep their crease), spatial-hash self-collision, long-range
  attachments to the pins, deformation-only damping, per-triangle aerodynamic drag. The
  hanger is a rigid body on a ball-joint hook (pins shape-matched about the hook each
  substep), so the swing comes from the cloth's mass; the pivot glide and the yaw are
  scripted (`src/cloth/ClothSolver.ts`).
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

The kits ship **pre-painted as GPU-compressed KTX2** (`public/kits/`, `src/jersey/kitFiles.ts`)
in two tiers: `r` (rack, and the modal on phones; colour 2048×1024) and `m` (modal on desktop;
colour 4096×2048, loaded on demand). Only the open jersey and its neighbours keep their `m`
kits in memory. Painting at runtime remains the fallback (missing files, or a `crestUrl`).
After changing kit data or the painter, rebuild them:

```bash
pnpm dev                       # then open /tools/kit-bake.html → assets-src/kits/*.png
brew install basis_universal   # once
tools/kits/encode.sh           # → public/kits/*.ktx2 (~3 min; optional glob: '*_color_r')
```

**Rack mesh detail** — side-on jerseys draw the light mesh (~6.7k tris); the turned-out one
swaps to the detailed one (~24k), and back once it has turned away again.

**Modal transition** — the jersey lifts off the rack: the rack publishes the jersey's screen
pose, the cloth spawns at exactly those pixels and glides to centre; the rack captures one
frame (with that jersey hidden), blurs it once into a still backdrop and stops rendering.
Closing flies the jersey back to its slot. ←/→ cross-dissolve: the old jersey drifts up and
fades, the next rises from below and fades in. Kits for the hovered jersey and the open
jersey's neighbours are painted ahead of time.

**Modal cloth feel** — `?tune` → *grab & drop*: presets (heavy knit / default / light
jersey) and every knob that shapes the grab and the settle — grab looseness / radius / max
pull / falloff, deformation damping, calm after drop (+ how long), speed cap, air drag, bend
softness, fold memory, stretch / compression softness, self-collision thickness, hook friction. All live; **copy settings** puts the current values
on the clipboard as JSON (defaults live in `src/config/physics.ts`, `CLOTH_FEEL`).

`?fps` shows a frame-rate overlay (handy on a real phone with `pnpm dev --host`).

> **TODO (follow-up):** real cut-out vent holes — alpha-tested perforations on the vent
> panels (a mask channel from the kit painter + a custom depth material for shadows), so
> you can see through to the inside of the tube.

## Quality tiers
Phones / coarse pointers / narrow screens start on `low` (smaller cloth grid, 1K/2K textures,
no post-processing, plain floor). On desktop the render scale adapts (1× / 1.25× / 1.5×; on
120 Hz screens it only steps down below 50 fps), and only if it's still too slow at 1× does it
drop to `low` (drei `PerformanceMonitor`, started after load; when it keeps flip-flopping it
just stops adapting).
Portrait screens browse the rack itself as a carousel (no modal): the active jersey turns out
facing front, tap it to flip it to its back, and ‹ › / swipe / tapping a neighbour steps to
another one (front first). In the modal, a click on the jersey flips it; a drag still grabs.
