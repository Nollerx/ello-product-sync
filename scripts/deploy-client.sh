#!/usr/bin/env bash
# Deploy the theme extension for a per-client custom-distribution app.
#
# Usage: scripts/deploy-client.sh <client-slug> <client-widget-url>
#   <client-slug>        matches shopify.app.<client-slug>.toml (scripts/new-client.sh)
#   <client-widget-url>  e.g. https://widget-<client>.ellotryon.com — the client's
#                        CDN worker custom domain (or the raw run.app URL before
#                        the worker exists). NO trailing slash.
#
# Same swap/restore mechanics as deploy-custom.sh, with one hard rule added:
# the baked-in URL swap FAILS LOUDLY if it would change nothing. The legacy
# script silently no-opped on drift, which deploys a theme extension pointed at
# the PUBLIC backend — wrong billing attribution and shared blast radius.
set -euo pipefail
cd "$(dirname "$0")/.."

SLUG="${1:?usage: scripts/deploy-client.sh <client-slug> <client-widget-url>}"
CLIENT_URL="${2:?usage: scripts/deploy-client.sh <client-slug> <client-widget-url>}"
CLIENT_URL="${CLIENT_URL%/}"
PUBLIC_URL="https://widget.ellotryon.com"

[ -f "shopify.app.${SLUG}.toml" ] || { echo "ERROR: shopify.app.${SLUG}.toml not found — run scripts/new-client.sh ${SLUG} first" >&2; exit 1; }
if grep -q REPLACE_ME "shopify.app.${SLUG}.toml"; then
  echo "ERROR: shopify.app.${SLUG}.toml still contains REPLACE_ME placeholders" >&2; exit 1
fi
case "$CLIENT_URL" in
  https://*) : ;;
  *) echo "ERROR: client widget URL must start with https://" >&2; exit 1;;
esac

FILES=(
  "extensions/ello-theme-extension/blocks/widget.liquid"
  "extensions/ello-theme-extension/blocks/inline-tryon-button.liquid"
  "extensions/ello-theme-extension/blocks/fitting-room.liquid"
)

# Fail-loud pre-check: every block must contain the expected baked-in URL,
# otherwise the sed below would silently deploy the wrong backend.
for f in "${FILES[@]}"; do
  grep -q "$PUBLIC_URL" "$f" || {
    echo "ERROR: $f does not contain ${PUBLIC_URL} — the URL swap would no-op." >&2
    echo "       The liquid source drifted; fix PUBLIC_URL here or the source first." >&2
    exit 1
  }
done

# Backups OUTSIDE the extension tree (Shopify rejects non-.liquid files in
# blocks/), restored on ANY exit so the tree always ends back on the public URL.
BACKUP_DIR="$(mktemp -d)"
restore() {
  for f in "${FILES[@]}"; do
    bak="$BACKUP_DIR/$(basename "$f")"
    [ -f "$bak" ] && cp -f "$bak" "$f"
  done
  rm -rf "$BACKUP_DIR"
}
trap restore EXIT

for f in "${FILES[@]}"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

# BSD sed (macOS) in-place edit, then assert the swap actually landed.
sed -i '' "s#${PUBLIC_URL}#${CLIENT_URL}#g" "${FILES[@]}"
for f in "${FILES[@]}"; do
  grep -q "$CLIENT_URL" "$f" || { echo "ERROR: swap did not land in $f — aborting before deploy" >&2; exit 1; }
done

echo "Deploying theme extension for '${SLUG}' pointed at ${CLIENT_URL} ..."
shopify app deploy --config "$SLUG" --force

echo
echo "Done. Next: scripts/verify-client.sh ${CLIENT_URL} <origin-run.app-URL> <store-slug>"
