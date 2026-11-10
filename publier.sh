#!/usr/bin/env bash
# Met à jour la version (numéro + date/heure de Paris) et les numéros anti-cache,
# puis publie sur GitHub.
# Usage : ./publier.sh "Message de commit"        -> version précédente + 0.1 (automatique)
#         ./publier.sh 3.0 "Message de commit"    -> numéro imposé
set -euo pipefail
cd "$(dirname "$0")"
ANCIEN=$(sed -nE "s/.*numero: '([0-9]+)\.([0-9]+)'.*/\1 \2/p" version.js)
if [[ $# -ge 2 ]]; then NUM="$1"; MSG="$2"; else
  read -r MAJ MIN <<< "$ANCIEN"; MIN=$((MIN + 1)); if (( MIN >= 10 )); then MAJ=$((MAJ + 1)); MIN=0; fi
  NUM="$MAJ.$MIN"; MSG="${1:?message}"; fi
[[ "$NUM" != "$(tr ' ' . <<< "$ANCIEN")" ]] || { echo "Le numéro $NUM est déjà en ligne : change-le." >&2; exit 1; }
MSG="v$NUM — $MSG"
DATE=$(TZ=Europe/Paris date +%Y-%m-%dT%H:%M:%S%:z)
V=$(date +%Y%m%d%H%M%S)
printf "// Version du site, mise à jour à chaque publication\nwindow.SPIRALE_VERSION = { numero: '%s', date: '%s' };\n" "$NUM" "$DATE" > version.js
sed -i -E "s#(style\.css|version\.js|analyse\.js|app\.js|prep\.css|prep\.js|prep-zones\.js|acces\.js)\?v=[0-9]+#\1?v=$V#g" index.html preparation.html
git add -A
git -c user.name="Leepreuve" -c user.email="Leepreuve@users.noreply.github.com" commit -q -m "$MSG

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KzLpcf4pEh1sFqqmLqKeu4"
git push -q origin main 2>&1 | grep -v "acknowledgments\|negotiation" || true
git log --oneline -1
