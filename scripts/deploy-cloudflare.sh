#!/usr/bin/env bash
# Publica o site estático no Cloudflare Workers (Pages integrado).
# Uso:
#   ./scripts/deploy-cloudflare.sh
#   CAPES_PDF_API='https://seu-servico.onrender.com' ./scripts/deploy-cloudflare.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$(mktemp -d)"
trap 'rm -rf "$DIST"' EXIT

mkdir -p "$DIST/public"
cp "$ROOT/index.html" "$DIST/public/"
cp -R "$ROOT/assets" "$DIST/public/assets"

if [ -n "${CAPES_PDF_API:-}" ]; then
  printf "window.CAPES_PDF_API = '%s';\n" "$CAPES_PDF_API" > "$DIST/public/assets/config.js"
  python3 - "$DIST/public/index.html" <<'PY'
import sys, time
caminho = sys.argv[1]
texto = open(caminho, encoding='utf-8').read()
texto = texto.replace(
    'assets/config.js?v=20261018g',
    'assets/config.js?v=%d' % int(time.time()),
)
open(caminho, 'w', encoding='utf-8').write(texto)
PY
fi

cat > "$DIST/wrangler.jsonc" <<'JSON'
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "capes-eduensino",
  "compatibility_date": "2026-10-18",
  "assets": { "directory": "./public" }
}
JSON

echo "Publicando $DIST/public em capes-eduensino..."
(cd "$DIST" && npx --yes wrangler deploy)
