#!/usr/bin/env bash
# Encodes the baked kit atlases (assets-src/kits/*.png, from tools/kit-bake.html) into
# public/kits/*.ktx2 with Basis Universal (brew install basis_universal).
#   colour  modal tier: UASTC + RDO + Zstandard, sRGB (lettering stays crisp up close)
#           rack tier: ETC1S, sRGB (half the size; indistinguishable at rack distance)
#   height  UASTC + RDO + Zstandard, linear (feeds the bump: blocky ETC1S shows as noise)
#   rough   ETC1S, linear                   (soft, low detail)
# All with mipmaps and flipped in Y (canvas rows are top-down; the UVs are v-up).
set -euo pipefail
cd "$(dirname "$0")/../.."
src=assets-src/kits
out=public/kits
mkdir -p "$out"
shopt -s nullglob
files=("$src"/${1:-*}.png)  # optional glob, e.g. tools/kits/encode.sh '*_color_r'
[ ${#files[@]} -gt 0 ] || { echo "no PNGs in $src — run /tools/kit-bake.html first" >&2; exit 1; }
for f in "${files[@]}"; do
  name=$(basename "$f" .png)
  case "$name" in
    *_color_r)  args=(-srgb -etc1s -quality 90 -effort 6 -ktx2) ;;
    *_color_*)  args=(-srgb -uastc -uastc_level 2 -uastc_rdo_l 1.0 -ktx2 -ktx2_zstandard_level 18) ;;
    *_height_*) args=(-uastc -uastc_level 2 -uastc_rdo_l 1.0 -ktx2 -ktx2_zstandard_level 18 -linear) ;;
    *_rough_*)  args=(-etc1s -quality 80 -ktx2 -linear) ;;
    *) continue ;;
  esac
  basisu "${args[@]}" -mipmap -y_flip -no_status_output -output_file "$out/$name.ktx2" "$f" >/dev/null
  echo "$name.ktx2 $(wc -c < "$out/$name.ktx2" | tr -d ' ') bytes"
done
