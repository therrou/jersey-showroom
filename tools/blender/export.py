"""Step 4 of the build: simulation cages, the low-poly render mesh, and the GLB.

    import export; export.run()

Writes public/models/jersey.glb (meshopt-compressed, EXT_meshopt_compression) and
public/models/jersey_normal.webp / jersey_ao.webp (UV1 maps).

Objects (glTF frame: +y up, front +z, origin at the top of the collar, metres):
  JerseyRender     ~24k tris  UV0 kit atlas, UV1 bake; _PATX/_PATY/_SIDE/_PART
  JerseyRenderLow  ~6k tris   same, coarser tube (same collar band + facings)
    (+ morph targets drape1..N on the render meshes and cages: drape variants, variants.py)
  JerseyCage       ~2.5k verts  welded tube on the same drape; _PATX/_PATY/_SIDE/_PIN
  JerseyCageLow    ~1.2k verts
_SIDE: 0 front, 1 back, 2 seam.  _PART: 0 body, 1 collar band, 2 rib facing.
_PIN: 1 where the cloth rests on the hanger (padded yoke + neck seam on the bar).
"""

import os

import bmesh
import bpy
import numpy as np

import drape
import garment
import variants
from patmap import PatternMap

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "public", "models")
CAGE_SPACING = 0.023
CAGE_LOW_SPACING = 0.033
RENDER_LOW_SPACING = 0.024
PIN_REACH = 0.012  # cloth within this of the yoke surface is resting on it


def _drape_map():
    m = drape.mesh_arrays(bpy.data.objects["JerseyDrape"])
    return PatternMap(m["co"], m["px"], m["py"], m["tris"], m["face_front"])


def _mapped_tube(spacing, name, pm):
    """A tube from the flat pattern at `spacing`, every vertex placed on the drape."""
    obj, _ = garment.build_tube(spacing, name)
    me = obj.data
    px = np.array([d.value for d in me.attributes["pat_x"].data])
    py = np.array([d.value for d in me.attributes["pat_y"].data])
    side = np.array([d.value for d in me.attributes["side"].data])
    co = np.array([pm.point(0 if s == 2 else s, (x, y)) for x, y, s in zip(px, py, side)])
    me.vertices.foreach_set("co", co.ravel())
    me.update()
    obj.vertex_groups.clear()
    return obj


def _yoke_distance(co):
    """Distance from each point to the padded yoke's surface (negative = inside)."""
    yoke = np.array(bpy.data.objects["JerseyDrape"]["yoke"])
    sy = garment.YOKE_DEPTH / garment.YOKE_RADIUS
    q = co / np.array([1.0, sy, 1.0])
    P = yoke / np.array([1.0, sy, 1.0])
    best = np.full(len(co), np.inf)
    for a, b in zip(P[:-1], P[1:]):
        ab = b - a
        t = np.clip(((q - a) @ ab) / (ab @ ab), 0, 1)
        best = np.minimum(best, np.linalg.norm(q - (a + t[:, None] * ab), axis=1))
    return best - garment.YOKE_RADIUS


def _float_attr(me, name, values):
    a = me.attributes.get(name) or me.attributes.new(name, "FLOAT", "POINT")
    a.data.foreach_set("value", np.asarray(values, dtype=np.float32))


def _export_attrs(obj, pins=None):
    me = obj.data
    get = lambda k: np.array([d.value for d in me.attributes[k].data], dtype=np.float32)
    _float_attr(me, "_PATX", get("pat_x"))
    _float_attr(me, "_PATY", get("pat_y"))
    _float_attr(me, "_SIDE", get("side"))
    if "part" in me.attributes:
        _float_attr(me, "_PART", get("part"))
    if pins is not None:
        _float_attr(me, "_PIN", pins)
    for p in me.polygons:
        p.use_smooth = True


def build_cage(spacing, name, pm):
    obj = _mapped_tube(spacing, name, pm)
    me = obj.data
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])  # UV seams would split the welded tube
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    neck = np.array([d.value for d in me.attributes["pin"].data]) > 0.5
    pins = (_yoke_distance(co) < PIN_REACH) | neck
    _export_attrs(obj, pins.astype(np.float32))
    return obj, int(pins.sum())


def build_render_low(pm, name="JerseyRenderLow"):
    tube = _mapped_tube(RENDER_LOW_SPACING, name + "_tube", pm)
    me = tube.data
    _float_attr(me, "part", np.zeros(len(me.vertices)))
    me.attributes["part"]  # float here; joined below with the int one from JerseyRender
    me.uv_layers.new(name="bake")
    kit = me.uv_layers["kit"]
    uv = np.empty(len(me.loops) * 2)
    kit.data.foreach_get("uv", uv)
    me.uv_layers["bake"].data.foreach_set("uv", uv)
    # the collar band + facings: the exact ones from JerseyRender (same bake UVs)
    src = bpy.data.objects["JerseyRender"]
    extra = src.copy()
    extra.data = src.data.copy()
    extra.name = name + "_extra"
    bpy.context.scene.collection.objects.link(extra)
    bm = bmesh.new()
    bm.from_mesh(extra.data)
    lay = bm.verts.layers.int.get("part")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v[lay] == 0], context="VERTS")
    bm.to_mesh(extra.data)
    bm.free()
    # match attribute types before joining
    for o in (tube, extra):
        m2 = o.data
        vals = np.array([d.value for d in m2.attributes["part"].data], dtype=np.float32)
        m2.attributes.remove(m2.attributes["part"])
        a = m2.attributes.new("part", "INT", "POINT")
        a.data.foreach_set("value", vals.astype(np.int32))
    bpy.ops.object.select_all(action="DESELECT")
    tube.select_set(True)
    extra.select_set(True)
    bpy.context.view_layer.objects.active = tube
    bpy.ops.object.join()
    tube.name = name
    tube.data.name = name
    tube.data.uv_layers.active = tube.data.uv_layers["kit"]
    return tube


def _export_copy(src_name, name):
    src = bpy.data.objects[src_name]
    o = src.copy()
    o.data = src.data.copy()
    o.name = name
    o.modifiers.clear()
    o.data.materials.clear()
    o.vertex_groups.clear()
    bpy.context.scene.collection.objects.link(o)
    for a in [a.name for a in o.data.attributes if a.name in ("raw_co",)]:
        o.data.attributes.remove(o.data.attributes[a])
    # glTF takes UV0/UV1 in layer order: kit first, bake second
    uvs = [u.name for u in o.data.uv_layers]
    assert uvs[:2] == ["kit", "bake"], uvs
    return o


def _save_webp(src_png, dst, quality):
    img = bpy.data.images.load(src_png, check_existing=False)
    img.colorspace_settings.name = "Non-Color"
    sc = bpy.context.scene
    s = sc.render.image_settings
    prev = (s.file_format, s.color_mode)
    s.file_format = "WEBP"
    s.quality = quality
    s.color_mode = "RGB"
    img.save_render(dst, scene=sc)
    s.file_format, s.color_mode = prev
    bpy.data.images.remove(img)
    return os.path.getsize(dst)


def run():
    os.makedirs(OUT, exist_ok=True)
    for n in ("JerseyCage", "JerseyCageLow", "JerseyRenderLow"):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o)
    pm = _drape_map()
    cage, pins = build_cage(CAGE_SPACING, "JerseyCage", pm)
    cage_low, pins_low = build_cage(CAGE_LOW_SPACING, "JerseyCageLow", pm)
    build_render_low(pm)
    # export copies carry the clean names; the working objects step aside meanwhile
    bpy.data.objects["JerseyRender"].name = "JerseyRender_src"
    bpy.data.objects["JerseyRenderLow"].name = "JerseyRenderLow_src"
    render = _export_copy("JerseyRender_src", "JerseyRender")
    render_low = _export_copy("JerseyRenderLow_src", "JerseyRenderLow")
    for o in (render, render_low):
        _export_attrs(o)
    drapes = variants.available()
    morphs = bool(drapes)
    report = {}
    if morphs:
        # the render meshes (rack) and the cages (the modal's cloth starts in the same drape)
        for o in (render, render_low, cage, cage_low):
            report[o.name + " morph max"] = variants.add_shape_keys(o, drapes)
    for o in (render, render_low, cage, cage_low):
        report[o.name] = (len(o.data.vertices), sum(len(p.vertices) - 2 for p in o.data.polygons))
    bpy.ops.object.select_all(action="DESELECT")
    for o in (render, render_low, cage, cage_low):
        o.select_set(True)
    path = os.path.join(OUT, "jersey.glb")
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_apply=True,
        export_texcoords=True, export_normals=True, export_materials="NONE",
        export_attributes=True, export_yup=True, export_animations=False, export_skins=False,
        export_morph=morphs, export_morph_normal=morphs, export_morph_tangent=False,
        export_cameras=False, export_lights=False,
        export_meshopt_compression_enable=True, export_meshopt_extension="EXT_meshopt_compression",
    )
    for o in (render, render_low):
        bpy.data.objects.remove(o)
    bpy.data.objects["JerseyRender_src"].name = "JerseyRender"
    bpy.data.objects["JerseyRenderLow_src"].name = "JerseyRenderLow"
    tex = os.path.join(ROOT, "assets-src", "textures")
    sizes = {
        "jersey_normal.webp": _save_webp(os.path.join(tex, "jersey_normal.png"), os.path.join(OUT, "jersey_normal.webp"), 92),
        "jersey_ao.webp": _save_webp(os.path.join(tex, "jersey_ao.png"), os.path.join(OUT, "jersey_ao.webp"), 85),
    }
    return dict(objects=report, pins=(pins, pins_low), glb=os.path.getsize(path), textures=sizes)
