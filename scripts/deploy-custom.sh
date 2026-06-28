#!/usr/bin/env bash
# Deploy the theme extension to the CUSTOM Shopify app.
#
# The widget's backend origin is baked into the .liquid source (see
# widget.liquid / inline-tryon-button.liquid) and defaults to the PUBLIC
# Cloud Run URL. Merchants can't change it. For the custom app we swap that
# baked-in URL to the custom service, deploy, then restore the source so the
# working tree always ends up back on the public URL.
#
# Backups are kept OUTSIDE the extension tree — Shopify rejects any non-.liquid
# file inside blocks/ during validation, so a backup next to the source would
# break the deploy.
set -euo pipefail

PUBLIC_URL="https://ello-vto-public-13593516897-u5htiuxfrq-uc.a.run.app"
CUSTOM_URL="https://custom-ello-app-13593516897-13593516897.us-central1.run.app"

FILES=(
  "extensions/ello-theme-extension/blocks/widget.liquid"
  "extensions/ello-theme-extension/blocks/inline-tryon-button.liquid"
  "extensions/ello-theme-extension/blocks/fitting-room.liquid"
)

BACKUP_DIR="$(mktemp -d)"

# Restore exact original bytes on any exit (success, failure, or Ctrl+C),
# so a swapped custom URL never gets left behind in the working tree.
restore() {
  for f in "${FILES[@]}"; do
    bak="$BACKUP_DIR/$(basename "$f")"
    if [ -f "$bak" ]; then
      cp -f "$bak" "$f"
    fi
  done
  rm -rf "$BACKUP_DIR"
}
trap restore EXIT

for f in "${FILES[@]}"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

# BSD sed (macOS) in-place edit.
sed -i '' "s#${PUBLIC_URL}#${CUSTOM_URL}#g" "${FILES[@]}"

shopify app deploy --config custom --force
