# Jersey build (Blender)

Builds `public/models/jersey.glb` (+ `jersey_normal.webp`, `jersey_ao.webp`) from the
flat pattern in `src/jersey/silhouette.ts`. Source scene: `assets-src/jersey.blend`.

Run inside Blender 5.x (MCP `execute_blender_code`, or the Python console) with this
folder on `sys.path`:

```python
import sys; sys.path.insert(0, "/path/to/hockey-jersey-rack/tools/blender")
import build; print(build.run())      # ~4 min
```

| step | module | what |
|---|---|---|
| pattern | `pattern.py` | FRONT/BACK pieces (V-neck on the front) sharing every seam point; kit-atlas UVs (`kit_uv`, same convention as `pushVertex` in `JerseyGeometry.ts`) |
| tube | `garment.py` | the sewn tube (seams welded), the hanger support, pins, start pose (sleeves forward of the side seams, seeded drape folds) |
| drape | `drape.py` + `xpbd.py` | numpy position-based cloth: flat-pattern stretch (soft in compression), bending, front↔back volume, tethers to the pins, hanger collision, self-collision, a soft guide for the sleeve hang angle |
| detail | `detail.py`, `collar.py`, `facings.py` | denoise; rib collar band along the draped neckline (UVs land on the painter's collar band); turned-under rib facings at hem and cuffs |
| bake | `bake.py` | `JerseyRender` (UV0 kit, UV1 bake), Catmull-Clark high-poly with seam grooves/topstitch/wrinkles, Cycles tangent normal (2K) + AO (1K) → `assets-src/textures/` |
| variants | `variants.py` | optional: `variants.drape_variant(i)` re-drapes the tube with other seeded folds / sleeve hang / solver noise (`JerseyDrapeVar<i>`, ~2.5 min each); the export adds them to the render meshes as morph targets `drape1..N`, which the rack blends per jersey |
| export | `export.py` | `JerseyCage` (~2.5k verts) / `JerseyCageLow` (~1.2k) on the same drape via `patmap.py`, `JerseyRenderLow` (~6.7k tris), meshopt GLB + WebP maps |

Why not Blender cloth: its collision with the thin hanger bar and the welded seams made
the drape unstable; the numpy solver is the same model family as the web solver and is
deterministic.

## Previewing real kits on the model

`pnpm dev`, then open `/tools/kit-export.html?kits=CAN,SWE,FIN` — it paints kits with the
app's painter and saves them to `tools/blender/kits/` (dev-only middleware in
`vite.config.ts`). In Blender: `preview.kit_material(obj, kits_dir, "CAN", textures_dir)`
and `preview.render_views([...], out_dir)`.

## Knobs worth knowing

- `garment.py`: `YOKE_*` (the hanger the shoulders rest on), `SLEEVE_FORWARD`,
  `FOLD_DEPTH`, `BODY_DEPTH` (tube volume).
- `drape.py`: `SLEEVE_HANG_DEG` (how far the sleeves swing down from the pattern's 55°),
  `SELF_RADIUS`/`SELF_EXCLUDE`.
- `export.py`: cage spacings, `PIN_REACH` (cloth within this of the hanger is pinned in
  the web solver).
