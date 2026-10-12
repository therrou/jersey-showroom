"""Step 3 of the build: assemble the render mesh and bake its normal + AO maps.

    import bake; bake.run(out_dir)

JerseyRender = draped tube + collar band + rib facings, with
  UV 'kit'  (UV0): the kit painter's atlas (collar/facings reuse painted rib areas)
  UV 'bake' (UV1): kit layout for the body, collar + facings packed into the atlas's
                   unused corners, so the baked maps have no overlaps
  attribute 'part': 0 body, 1 collar band, 2 facing
A Catmull-Clark high-poly copy gets the fine detail (seam grooves and topstitching,
compression wrinkles) as real displacement; Cycles bakes it to a tangent-space normal
map and AO on UV1.
"""

import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import noise, Vector

import drape

NORMAL_SIZE = 2048
AO_SIZE = 1024


def _copy(name, new_name):
    src = bpy.data.objects[name]
    o = src.copy()
    o.data = src.data.copy()
    o.name = new_name
    o.modifiers.clear()
    bpy.context.scene.collection.objects.link(o)
    return o


def _set_point_attr(me, name, kind, values):
    a = me.attributes.get(name) or me.attributes.new(name, kind, "POINT")
    a.data.foreach_set("value", values)


def assemble(name="JerseyRender"):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old)
    parts = []
    for i, src in enumerate(("JerseyDrape", "CollarBand", "RibFacings")):
        o = _copy(src, f"_{name}_{i}")
        me = o.data
        n = len(me.vertices)
        _set_point_attr(me, "part", "INT", [i] * n)
        if i:
            for a, v in (("seam_dist", 1.0), ("pat_x", 0.0), ("pat_y", 0.0), ("pin", 0.0)):
                _set_point_attr(me, a, "FLOAT", [v] * n)
            for a, v in (("side", 0), ("open_edge", 0)):
                _set_point_attr(me, a, "INT", [v] * n)
        for a in ("raw_co",):
            if a in me.attributes:
                me.attributes.remove(me.attributes[a])
        o.vertex_groups.clear()
        parts.append(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    o = parts[0]
    o.name = name
    o.data.name = name
    for p in o.data.polygons:
        p.use_smooth = True
    _bake_uvs(o)
    return o


def _bake_uvs(o):
    me = o.data
    kit = me.uv_layers["kit"]
    bake_uv = me.uv_layers.get("bake") or me.uv_layers.new(name="bake")
    part = np.array([d.value for d in me.attributes["part"].data])
    loop_vert = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get("vertex_index", loop_vert)
    pin = part[loop_vert] == 0
    # body: the kit layout; collar + facings keep their own unfolded strip layout
    uv = np.empty(len(me.loops) * 2)
    kit.data.foreach_get("uv", uv)
    ub = np.empty(len(me.loops) * 2)
    bake_uv.data.foreach_get("uv", ub)
    ub = np.where(np.repeat(pin, 2), uv, ub)
    bake_uv.data.foreach_set("uv", ub)
    # pin the body's islands where they are; pack the collar + facings into free space
    bake_uv.data.foreach_set("pin_uv", pin)
    me.uv_layers.active = bake_uv
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(udim_source="CLOSEST_UDIM", rotate=True, scale=True, margin=0.004,
                            pin=True, pin_method="LOCKED", shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")
    me.uv_layers.active = kit
    kit.active_render = True


def uv_overlap_report(o, layer="bake", res=512):
    """Fraction of rasterised UV texels covered by more than one face (0 = clean)."""
    me = o.data
    uvl = me.uv_layers[layer]
    cover = np.zeros((res, res), np.int16)
    for p in me.polygons:
        pts = np.array([uvl.data[i].uv[:] for i in p.loop_indices]) * res
        lo = np.floor(pts.min(0)).astype(int)
        hi = np.ceil(pts.max(0)).astype(int)
        lo = np.clip(lo, 0, res - 1)
        hi = np.clip(hi, 0, res)
        if (hi - lo).prod() == 0:
            continue
        ys, xs = np.mgrid[lo[1] : hi[1], lo[0] : hi[0]] + 0.5
        a, b, c = pts[0], pts[1], pts[2]
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-12:
            continue
        l1 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / d
        l2 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / d
        inside = (l1 >= 0) & (l2 >= 0) & (l1 + l2 <= 1)
        cover[lo[1] : hi[1], lo[0] : hi[0]] += inside
    used = (cover > 0).sum()
    return float((cover > 1).sum()) / max(used, 1)


# --- high-poly detail ----------------------------------------------------------------


def highpoly(src="JerseyRender", name="JerseyHigh", levels=2):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old)
    o = _copy(src, name)
    mod = o.modifiers.new("Subd", "SUBSURF")
    mod.levels = levels
    mod.render_levels = levels
    mod.uv_smooth = "PRESERVE_BOUNDARIES"
    mod.boundary_smooth = "PRESERVE_CORNERS"
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.ops.object.modifier_apply(modifier="Subd")
    _displace_detail(o)
    return o


def _displace_detail(o):
    me = o.data
    me.update()
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    nrm = np.empty(n * 3)
    me.vertices.foreach_get("normal", nrm)
    nrm = nrm.reshape(-1, 3)
    A = lambda k: np.array([d.value for d in me.attributes[k].data])
    part, ds, px, py = A("part"), A("seam_dist"), A("pat_x"), A("pat_y")
    body = part == 0

    # seams: the welded edge pulls in a narrow groove, with a raised topstitch either side
    groove = -0.0009 * np.exp(-((ds / 0.0025) ** 2))
    stitch = 0.00035 * np.exp(-(((ds - 0.0055) / 0.0016) ** 2))
    disp = np.where(body, groove + stitch, 0.0)

    # fine wrinkles: anisotropic noise in pattern space (running down the body, along the
    # sleeves), strongest where the drape compresses the fabric (underarms, elbows, hem)
    sx, sy = 0.235, -0.05
    ax = np.abs(px)
    sleeve = np.clip((ax - 0.28) / 0.08, 0, 1) * np.clip((-py - 0.12) / 0.1, 0, 1)
    armpit = np.exp(-(((ax - 0.318) ** 2 + (py + 0.335) ** 2) / 0.07 ** 2))
    hem = np.clip((-py - 0.62) / 0.2, 0, 1)
    amp = 0.0004 + 0.0016 * armpit + 0.0008 * hem + 0.0007 * sleeve
    wr = np.empty(n)
    for i in range(n):
        if not body[i]:
            wr[i] = 0.0
            continue
        # stretch the noise along the drape direction: down the body, along the sleeves
        if sleeve[i] > 0.5:
            dx, dy = 0.239, -0.52  # shoulder → cuff, pattern space
            L = math.hypot(dx, dy)
            along = ((ax[i] - sx) * dx + (py[i] - sy) * dy) / L
            across = ((ax[i] - sx) * -dy + (py[i] - sy) * dx) / L
            q = Vector((across * 38.0, along * 9.0, 0.37))
        else:
            q = Vector((px[i] * 38.0, py[i] * 9.0, 0.37))
        wr[i] = noise.noise(q) * 0.7 + noise.noise(q * 2.1 + Vector((3.1, 1.7, 0))) * 0.3
    disp += wr * amp
    co += nrm * disp[:, None]
    me.vertices.foreach_set("co", co.ravel())
    me.update()


# --- bake ----------------------------------------------------------------------------


def _image(name, size, non_color):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def _bake_target(o, img):
    mat = bpy.data.materials.get("BakeTarget") or bpy.data.materials.new("BakeTarget")
    mat.use_nodes = True
    nt = mat.node_tree
    tex = next((nd for nd in nt.nodes if nd.type == "TEX_IMAGE"), None) or nt.nodes.new("ShaderNodeTexImage")
    uvn = next((nd for nd in nt.nodes if nd.type == "UVMAP"), None) or nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "bake"
    nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
    tex.image = img
    for nd in nt.nodes:
        nd.select = False
    tex.select = True
    nt.nodes.active = tex
    o.data.materials.clear()
    o.data.materials.append(mat)


def clean_normals(img, min_z=0.6):
    """Texels tilted past ~50° are bake misses (the ray found a neighbouring surface in
    a tight underarm fold), not detail: blend them back to flat."""
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    z = px[..., 2] * 2 - 1
    bad = z < min_z
    t = np.clip((min_z - z) / 0.2, 0, 1)[..., None]
    flat = np.array([0.5, 0.5, 1.0], np.float32)
    px[..., :3] = np.where(bad[..., None], px[..., :3] * (1 - t) + flat * t, px[..., :3])
    img.pixels = px.ravel()
    return int(bad.sum())


def bake(out_dir, low="JerseyRender", high="JerseyHigh"):
    os.makedirs(out_dir, exist_ok=True)
    sc = bpy.context.scene
    prev_engine = sc.render.engine
    sc.render.engine = "CYCLES"
    sc.cycles.device = "GPU" if bpy.context.preferences.addons.get("cycles") else "CPU"
    lo = bpy.data.objects[low]
    hi = bpy.data.objects[high]
    lo.data.uv_layers.active = lo.data.uv_layers["bake"]
    hidden = []
    for ob in sc.objects:
        if ob not in (lo, hi) and not ob.hide_render:
            ob.hide_render = True
            hidden.append(ob)
    bpy.ops.object.select_all(action="DESELECT")
    hi.select_set(True)
    lo.select_set(True)
    bpy.context.view_layer.objects.active = lo
    bk = sc.render.bake
    bk.use_selected_to_active = True
    bk.cage_extrusion = 0.003
    bk.max_ray_distance = 0.007
    bk.margin = 8

    nimg = _image("jersey_normal", NORMAL_SIZE, True)
    _bake_target(lo, nimg)
    sc.cycles.samples = 1
    bk.normal_space = "TANGENT"
    bpy.ops.object.bake(type="NORMAL")
    clean_normals(nimg)
    nimg.filepath_raw = os.path.join(out_dir, "jersey_normal.png")
    nimg.file_format = "PNG"
    nimg.save()

    aimg = _image("jersey_ao", AO_SIZE, True)
    _bake_target(lo, aimg)
    sc.cycles.samples = 128
    sc.world.light_settings.distance = 0.12  # AO reach: folds, armpits, under the collar
    bpy.ops.object.bake(type="AO")
    aimg.filepath_raw = os.path.join(out_dir, "jersey_ao.png")
    aimg.file_format = "PNG"
    aimg.save()

    for ob in hidden:
        ob.hide_render = False
    lo.data.uv_layers.active = lo.data.uv_layers["kit"]
    sc.render.engine = prev_engine
    return nimg, aimg


def run(out_dir):
    lo = assemble()
    overlap = uv_overlap_report(lo)
    highpoly()
    bake(out_dir)
    return overlap
