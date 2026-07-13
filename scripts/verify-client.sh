#!/usr/bin/env bash
# Go-live verification sweep for a client's widget hostname.
#
# Usage: scripts/verify-client.sh <widget-base-url> <origin-run-url> <store-slug>
#   <widget-base-url>  https://widget-<client>.ellotryon.com (CDN worker domain)
#   <origin-run-url>   the client's Cloud Run URL (for byte-parity check)
#   <store-slug>       the client's vto_stores.store_slug
#
# Read-only except one oversized junk POST to /tryon (expects a fast 413 —
# no render, no billing). Exit code = number of failed checks.
set -uo pipefail

W="${1:?usage: verify-client.sh <widget-base-url> <origin-run-url> <store-slug>}"
O="${2:?usage: verify-client.sh <widget-base-url> <origin-run-url> <store-slug>}"
S="${3:?usage: verify-client.sh <widget-base-url> <origin-run-url> <store-slug>}"
W="${W%/}"; O="${O%/}"

PASS=0; FAIL=0
check() { # name ok detail
  if [ "$2" = "1" ]; then printf 'PASS  %-34s %s\n' "$1" "$3"; PASS=$((PASS+1));
  else printf 'FAIL  %-34s %s\n' "$1" "$3"; FAIL=$((FAIL+1)); fi
}

# 1. widget-main served, via Cloudflare
hdrs=$(curl -sI "$W/widget-main.js" | tr -d '\r')
code=$(printf '%s' "$hdrs" | head -1 | awk '{print $2}')
check "widget-main.js 200 via CDN" "$([ "$code" = "200" ] && echo 1 || echo 0)" "http=$code"
cf=$(printf '%s\n' "$hdrs" | grep -i '^cf-cache-status:' || true)
check "Cloudflare in path" "$([ -n "$cf" ] && echo 1 || echo 0)" "${cf:-no cf-cache-status header}"

# 2. loader served
lcode=$(curl -s -o /dev/null -w '%{http_code}' "$W/widget-loader.js")
check "widget-loader.js 200" "$([ "$lcode" = "200" ] && echo 1 || echo 0)" "http=$lcode"

# 3. compressed transfer size sane (<200KB means minified+compressed path intact)
bytes=$(curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}' "$W/widget-main.js")
check "compressed widget <200KB" "$([ "${bytes:-999999}" -lt 200000 ] && echo 1 || echo 0)" "${bytes} bytes"

# 4. config endpoint resolves for the store
ccode=$(curl -s -o /dev/null -w '%{http_code}' "$W/api/widget-config-resolved?store_slug=$S")
check "widget-config-resolved 200" "$([ "$ccode" = "200" ] && echo 1 || echo 0)" "http=$ccode slug=$S"

# 5. byte parity CDN vs origin
h1=$(curl -s "$W/widget-main.js" | shasum -a 256 | awk '{print $1}')
h2=$(curl -s "$O/widget-main.js" | shasum -a 256 | awk '{print $1}')
check "CDN/origin byte parity" "$([ -n "$h1" ] && [ "$h1" = "$h2" ] && echo 1 || echo 0)" "cdn=${h1:0:12} origin=${h2:0:12}"

# 6. oversized-body guard (9MB junk → 413, fast, nothing rendered or billed)
tcode=$(head -c 9000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' --data-binary @- "$W/tryon" --max-time 20)
check "/tryon 8MB guard (413)" "$([ "$tcode" = "413" ] && echo 1 || echo 0)" "http=$tcode"

echo
echo "$PASS passed, $FAIL failed."
echo "Manual remainder: one real render on the live PDP, shopper-cap 429 test,"
echo "exposure rows in vto_ab_exposures after Proof start, error rates day 1."
exit "$FAIL"
