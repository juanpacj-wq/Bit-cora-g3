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
BRANCH="${BRANCH:-main}"                 # rama que sirve producción (override: BRANCH=feat/x bash update.sh)
export APP_BASE_PATH=/bitacora          # DEBE coincidir con el .env y el nginx

cd "$APP_DIR"

# Gotcha recurrente: .git/objects a veces queda como root tras operaciones con sudo
# y rompe el pull ("insufficient permission for adding an object"). Lo normalizamos.
sudo chown -R "$(id -un):$(id -gn)" .git 2>/dev/null || true

# Guards (metodología v2, Fase F): no se despliega desde una rama distinta a la que sirve, ni con
# cambios locales, ni un commit sin tag deploy/YYYY-MM-DD (FORCE_SIN_TAG=1 para saltarlo con constancia).
ACTUAL=$(git branch --show-current)
if [ "$ACTUAL" != "$BRANCH" ]; then
  echo "✗ El servidor está en la rama '$ACTUAL' y este script despliega '$BRANCH'." >&2
  echo "  Si '$ACTUAL' es la rama correcta: BRANCH=$ACTUAL bash update.sh. Si no, resuélvelo a mano (git checkout) y regístralo en docs/deployment-unificado.md." >&2
  exit 2
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Hay cambios locales sin commitear en $APP_DIR; el despliegue solo publica lo que está en git." >&2
  git status --short >&2
  exit 2
fi
echo "==> git pull ($BRANCH)"
BEFORE=$(git rev-parse HEAD)
git fetch origin "$BRANCH" --tags
if ! git tag --points-at "origin/$BRANCH" | grep -q '^deploy/'; then
  if [ "${FORCE_SIN_TAG:-0}" != "1" ]; then
    echo "✗ origin/$BRANCH no tiene un tag deploy/YYYY-MM-DD: etiqueta el commit a desplegar (git tag deploy/$(date +%F) && git push origin --tags) o usa FORCE_SIN_TAG=1." >&2
    exit 2
  fi
  echo "!! Desplegando SIN tag deploy/ (FORCE_SIN_TAG=1) — déjalo escrito en docs/deployment-unificado.md"
fi
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

# D-047: si el unit de systemd cambió en el repo (p.ej. Environment=NODE_EXTRA_CA_CERTS), el
# instalado en /etc/systemd/system NO se actualiza solo con el pull — lo sincronizamos acá.
UNIT_SRC="$APP_DIR/deploy/bitacora-api.service"
UNIT_DST=/etc/systemd/system/bitacora-api.service
if ! sudo cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  echo "==> Unit de systemd cambió: lo actualizo + daemon-reload"
  sudo cp "$UNIT_SRC" "$UNIT_DST"
  sudo systemctl daemon-reload
fi

echo "==> Reinicio backend bitacora-api"
sudo systemctl restart bitacora-api
sudo systemctl --no-pager status bitacora-api | head -5

echo ""
echo "==> LISTO ✅  https://pgen.gecelca.com.co/bitacora/   (Ctrl+F5 para saltar caché)"
