#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Actualiza Bitácora en producción tras un push. Idempotente y seguro:
#   1. Trae el código de la rama de producción.
#   2. Reinstala dependencias SOLO si cambió package.json / package-lock.json.
#   3. Reconstruye el frontend con el base de prod (APP_BASE_PATH=/bitacora).
#   4. Reinicia el backend (bitacora-api) — barato e inocuo (sesiones viven en BD).
#
# Uso (en el servidor, como el usuario jcespedes):
#   bash /var/www/bitacora/deploy/update.sh
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR=/var/www/bitacora
BRANCH=sec/audseg-remediation           # rama que sirve producción
export APP_BASE_PATH=/bitacora          # DEBE coincidir con el .env y el nginx

cd "$APP_DIR"

# Gotcha recurrente: .git/objects a veces queda como root tras operaciones con sudo
# y rompe el pull ("insufficient permission for adding an object"). Lo normalizamos.
sudo chown -R "$(id -un):$(id -gn)" .git 2>/dev/null || true

echo "==> git pull ($BRANCH)"
BEFORE=$(git rev-parse HEAD)
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "==> Sin cambios nuevos (ya estaba en $AFTER). Reconstruyo igual por si acaso."
fi

# Reinstala dependencias solo si cambió el manifiesto/lockfile en este pull.
if ! git diff --quiet "$BEFORE" "$AFTER" -- package.json package-lock.json; then
  echo "==> Dependencias cambiaron: npm install"
  npm install
else
  echo "==> Dependencias sin cambios (omito npm install)"
fi

echo "==> Build frontend (APP_BASE_PATH=$APP_BASE_PATH)"
npm run build

echo "==> Reinicio backend bitacora-api"
sudo systemctl restart bitacora-api
sudo systemctl --no-pager status bitacora-api | head -5

echo ""
echo "==> LISTO ✅  https://pgen.gecelca.com.co/bitacora/   (Ctrl+F5 para saltar caché)"
