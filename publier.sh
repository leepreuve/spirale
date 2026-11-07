#!/usr/bin/env bash
# Met à jour la version (numéro + date/heure de Paris) et les numéros anti-cache,
# puis publie sur GitHub. Usage : ./publier.sh 2.1 "Message de commit"
set -euo pipefail
cd "$(dirname "$0")"
NUM="${1:?numéro de version}"
MSG="${2:?message}"
DATE=$(TZ=Europe/Paris date +%Y-%m-%dT%H:%M:%S%:z)
V=$(date +%Y%m%d%H%M%S)
printf "// Version du site, mise à jour à chaque publication\nwindow.SPIRALE_VERSION = { numero: '%s', date: '%s' };\n" "$NUM" "$DATE" > version.js
sed -i -E "s#(style\.css|version\.js|analyse\.js|app\.js|prep\.css|prep\.js|acces\.js)\?v=[0-9]+#\1?v=$V#g" index.html preparation.html
git add -A
git -c user.name="Leepreuve" -c user.email="Leepreuve@users.noreply.github.com" commit -q -m "$MSG

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KzLpcf4pEh1sFqqmLqKeu4"
git push -q origin main 2>&1 | grep -v "acknowledgments\|negotiation" || true
git log --oneline -1
