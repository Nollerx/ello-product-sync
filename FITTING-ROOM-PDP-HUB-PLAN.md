# PDP Try-on Hub + Image-Swap — execution plan

Owner: Andrew · Dialed 2026-06-28 · Target: LA Apparel re-install (no-widget stores)

## The model (locked)

The **inline Try-on button on the PDP is the sole entry** (menu-bar/header entry dropped).
It opens the existing widget panel launcher-less and **never auto-fires blind**:

- **First time (no saved photo)** → first-run screen only: explainer (You→Item→Result strip / short video) + `Use my photo / Use a model`. The instant the photo uploads → **auto-fire** the try-on for the current product → swap the PDP image.
- **Returning (saved photo)** → overlay home, **no auto-fire**: `Use this photo → Try it on` primary, with `Browse collection · Your wardrobe · Change photo` secondary. Commit → swap the PDP image.

The **PDP image-swap is the conversion climax**: on a successful try-on the panel gets out of the way, the result replaces the PDP main gallery image (original → corner thumbnail to revert), and the theme's own Add to Cart / Buy It Now sit right there.

Bubble/widget mode for normal stores stays **untouched**. Everything new is gated behind an explicit, default-OFF flag so no existing merchant changes.

## Gating

New behavior runs only when `elloPdpHubModeOn()` is true:
- `window.ELLO_STORE_CONFIG.pdpImageSwapEnabled === true` (explicit opt-in), else `false`.
- Default OFF → existing merchants and the current paying custom-app merchant are unaffected.
- Enable path for LA Apparel: DB column `vto_stores.pdp_image_swap_enabled` → `get_widget_config` RPC → loader maps it. Dev: `dev-pdp.html` sets it on `ello:config-resolved`.

## Key code anchors (read 2026-06-28)

- Entry: `inline-tryon-button.liquid` → `window.Ello.openTryOn(ctx)` → `elloOpenTryOnFromInline` (`widget-main.js:6226`, sets `ELLO_INLINE_MODE`, `ELLO_AUTO_FIRE=true`, `ELLO_INLINE_CTX`).
- `openWidget` (`2845`): auto-fire path A for returning users (`2966` priming, `3009` fire).
- `handlePhotoUpload` (`4209`): auto-fire path B, first-time, fires after upload (`4286`).
- `startTryOn` (`7181`): success path renders result into `#resultSection` / `#ello-tryon-result-image` (`7324`), then `renderInlineModeResultCtas` (`6873`).
- Inline home helpers: `setupInlineModeProductPreview` (`6427`), inline-mode CSS (`6460`, hides browse/wardrobe).
- Hub modals: `openClothingBrowser`/`closeClothingBrowser` (`5252`/`5275`), `openWardrobe`/`closeWardrobe` (`8964`/`8973`) — today `closeWidget()` on close (teardown).
- Loader config: `buildConfigFromRow` (`widget-loader.js:308`), `buildDefaultConfig` (`350`).
- Dev harness: `dev-pdp.html` (`#pdp-main-image`, simulates bubble-off LA Apparel).

## Increments (each independently verifiable in dev-pdp.html)

- **0 — Flag + plumbing.** `elloPdpHubModeOn()` helper; map `pdpImageSwapEnabled` in loader `buildConfigFromRow`/`buildDefaultConfig`; set it in `dev-pdp.html`. No behavior change for default stores. ✅ target
- **1 — Returning = no auto-fire → home.** In `openWidget` path A, when `elloPdpHubModeOn()` skip the fire + loading prime; land on the inline home (photo + product + "Try it on"). First-time path B still fires after upload. ✅ target
- **2 — Browse + Wardrobe in the home.** Surface secondary doors in the inline home for hub mode; make `closeClothingBrowser`/`closeWardrobe` return to the home instead of teardown when opened from it. (stage)
- **3 — PDP image-swap.** `elloBeginPdpSwapLoading` (hide panel + loading badge top-right of PDP image), `elloFinishPdpSwap(resultUrl)` (swap main image, original → corner thumbnail, revert), hardened selector list + fallback to in-panel result. Branch `startTryOn` success in hub mode to render onto the PDP. ✅ target (the must)
- **4 — First-run video.** `<video>` (muted/loop/playsinline, poster) in the first-run overlay, hub mode + first visit only; fallback to the existing You→Item→Result strip until Andrew supplies the MP4. (stage)
- **5 — Real enablement.** DB migration `pdp_image_swap_enabled` + RPC passthrough + admin Settings toggle. (stage; flip column directly for LA Apparel until the toggle ships.)

## Guardrails

- Pre-deploy gate: `npm run lint && npm run typecheck && npm run build`.
- Verify locally in `dev-pdp.html` via `npm run vite` before any deploy.
- Deploy target is CUSTOM only and Andrew installs — do not deploy from here.
- All edits additive + gated; bubble mode and the existing inline auto-fire behavior for non-hub stores must be byte-for-byte unchanged.
