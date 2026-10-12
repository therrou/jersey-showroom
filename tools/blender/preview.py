"""Studio preview renders of the garment: front, side, three-quarter (and back).

    import preview; preview.render_views(["JerseyDrape", "HangerCollider"], "/tmp/out")
Writes <out>/<view>.png plus a contact sheet <out>/sheet.png.
"""

import math
import os

import bpy
from mathutils import Vector

VIEWS = {
    "front": (0.0, -1.0, 0.12),
    "side": (1.0, 0.0, 0.08),
    "three_quarter": (0.75, -0.9, 0.25),
    "back": (0.0, 1.0, 0.12),
}
TARGET = Vector((0.0, 0.0, -0.42))  # middle of the hanging garment


def _ensure(name, factory):
    obj = bpy.data.objects.get(name)
    if obj is None:
        obj = factory()
        bpy.context.scene.collection.objects.link(obj)
    return obj


def setup_studio():
    sc = bpy.context.scene
    try:
        sc.render.engine = "BLENDER_EEVEE"
    except TypeError:
        pass
    world = sc.world or bpy.data.worlds.new("World")
    sc.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (0.16, 0.16, 0.17, 1)
    bg.inputs[1].default_value = 0.6

    def light(name, kind, energy, loc, size):
        def f():
            ld = bpy.data.lights.new(name, kind)
            return bpy.data.objects.new(name, ld)

        o = _ensure(name, f)
        o.data.energy = energy
        if kind == "AREA":
            o.data.size = size
        o.location = loc
        d = TARGET - Vector(loc)
        o.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        return o

    light("PrevKey", "AREA", 120, (-1.4, -1.0, 0.9), 0.8)  # raking, shows the drape
    light("PrevFill", "AREA", 40, (-1.6, -1.0, 0.0), 1.5)
    light("PrevRim", "AREA", 80, (0.4, 1.8, 0.5), 1.0)
    for o in bpy.data.objects:
        if o.type == "LIGHT" and not o.name.startswith("Prev"):
            o.hide_render = True

    cam = _ensure("PrevCam", lambda: bpy.data.objects.new("PrevCam", bpy.data.cameras.new("PrevCam")))
    cam.data.lens = 85
    sc.camera = cam
    sc.render.resolution_x = 640
    sc.render.resolution_y = 720
    sc.render.film_transparent = False
    return cam


def neutral_material(obj, color=(0.62, 0.64, 0.68, 1)):
    mat = bpy.data.materials.get("PrevFabric") or bpy.data.materials.new("PrevFabric")
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = 0.85
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def render_views(targets, out_dir, views=("front", "side", "three_quarter"), distance=2.3):
    os.makedirs(out_dir, exist_ok=True)
    cam = setup_studio()
    sc = bpy.context.scene
    hidden = []
    for o in bpy.data.objects:
        if o.type == "MESH" and o.name not in targets and not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    paths = []
    for v in views:
        d = Vector(VIEWS[v]).normalized()
        cam.location = TARGET + d * distance
        cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
        path = os.path.join(out_dir, f"{v}.png")
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        paths.append(path)
    for o in hidden:
        o.hide_render = False
    return contact_sheet(paths, os.path.join(out_dir, "sheet.png"))


def contact_sheet(paths, out):
    imgs = [bpy.data.images.load(p, check_existing=False) for p in paths]
    w, h = imgs[0].size
    sheet = bpy.data.images.new("sheet", w * len(imgs), h)
    import numpy as np

    px = np.zeros((h, w * len(imgs), 4), dtype=np.float32)
    for i, im in enumerate(imgs):
        a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
        px[:, i * w : (i + 1) * w] = a
        bpy.data.images.remove(im)
    sheet.pixels = px.ravel()
    sheet.filepath_raw = out
    sheet.file_format = "PNG"
    sheet.save()
    bpy.data.images.remove(sheet)
    return out


def kit_material(obj, kit_dir, code, tex_dir, checker=False):
    """Preview the real kit painter output (tools/kit-export.html) on the render mesh:
    colour / height / roughness on UV 'kit', baked normal + AO on UV 'bake'."""
    name = f"Kit_{code}" if not checker else "Kit_checker"
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    uv_kit = nt.nodes.new("ShaderNodeUVMap")
    uv_kit.uv_map = "kit"
    uv_bake = nt.nodes.new("ShaderNodeUVMap")
    uv_bake.uv_map = "bake"

    def tex(path, non_color, uv, generated=None):
        t = nt.nodes.new("ShaderNodeTexImage")
        if generated:
            img = bpy.data.images.get("uvgrid") or bpy.data.images.new("uvgrid", 2048, 2048)
            img.generated_type = "COLOR_GRID"
            t.image = img
        else:
            t.image = bpy.data.images.load(path, check_existing=True)
            if non_color:
                t.image.colorspace_settings.name = "Non-Color"
        nt.links.new(uv.outputs["UV"], t.inputs["Vector"])
        return t

    if checker:
        col = tex(None, False, uv_kit, generated=True)
    else:
        col = tex(f"{kit_dir}/{code}_color.png", False, uv_kit)
        h = tex(f"{kit_dir}/{code}_height.png", True, uv_kit)
        r = tex(f"{kit_dir}/{code}_rough.png", True, uv_kit)
        nt.links.new(r.outputs["Color"], bsdf.inputs["Roughness"])
    ao = tex(f"{tex_dir}/jersey_ao.png", True, uv_bake)
    nmap_t = tex(f"{tex_dir}/jersey_normal.png", True, uv_bake)
    mul = nt.nodes.new("ShaderNodeMixRGB")
    mul.blend_type = "MULTIPLY"
    mul.inputs["Fac"].default_value = 0.8
    nt.links.new(col.outputs["Color"], mul.inputs["Color1"])
    nt.links.new(ao.outputs["Color"], mul.inputs["Color2"])
    nt.links.new(mul.outputs["Color"], bsdf.inputs["Base Color"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nm.uv_map = "bake"
    nt.links.new(nmap_t.outputs["Color"], nm.inputs["Color"])
    if checker:
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    else:
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = 0.35
        bump.inputs["Distance"].default_value = 0.002
        nt.links.new(h.outputs["Color"], bump.inputs["Height"])
        nt.links.new(nm.outputs["Normal"], bump.inputs["Normal"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Sheen Weight"].default_value = 0.2
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return mat
