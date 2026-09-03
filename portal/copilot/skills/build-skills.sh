#!/bin/sh
# Package each skill folder as a .zip with SKILL.md at the archive root,
# which is the shape Copilot Studio's skill upload expects.
#
#   sh build-skills.sh
#
# Writes dist/<skill-name>.zip. Re-run after editing any SKILL.md.
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/*.zip

for dir in */; do
  name=${dir%/}
  [ "$name" = "dist" ] && continue
  [ -f "$name/SKILL.md" ] || continue
  ( cd "$name" && zip -q -r "../dist/$name.zip" . -x '.*' )
  printf '%-26s %s bytes\n' "$name.zip" "$(wc -c < "dist/$name.zip" | tr -d ' ')"
done
