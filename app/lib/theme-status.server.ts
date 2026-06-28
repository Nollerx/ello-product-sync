// Live detection of whether Ello's storefront placements are actually on the
// merchant's PUBLISHED theme — the source of truth, replacing the stale
// `vto_stores.widget_enabled` DB flag (which only tracked install/uninstall).
//
// Best practice (Shopify Admin API 2025-10): read the live theme's files via
// the GraphQL `themes(roles:[MAIN])` → `OnlineStoreTheme.files` connection and
// inspect them. App embeds live in `config/settings_data.json` under
// `current.blocks`; app blocks (the inline button) live in the product
// template JSON under `sections[].blocks[]`. Requires the `read_themes` scope
// (read-only — NOT an exemption-gated/protected scope; only theme *writes* are).
//
// We deliberately match on the theme app extension BLOCK HANDLE (the Liquid
// filename: "widget" / "inline-tryon-button"), not on the extension UUID — the
// trailing `{unique-id}` segment of a block `type` is not guaranteed to equal
// the registered extension UUID, and the handle is stable across the public and
// custom apps (same extension code, different api_key).

import { supabaseAdmin } from "./supabase.server";

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

// Block handles = the Liquid filenames under extensions/ello-theme-extension/blocks.
export const APP_EMBED_BLOCK_HANDLE = "widget";
export const INLINE_BUTTON_BLOCK_HANDLE = "inline-tryon-button";

export type ThemeStatusReason =
  | "ok"
  | "missing_scope"
  | "no_published_theme"
  | "graphql_error"
  | "no_json_product_template";

export type ThemeWidgetStatus = {
  /** True only if we successfully read the theme. */
  ok: boolean;
  themeId: string | null;
  themeName: string | null;
  /** Whether the floating-widget app embed exists in settings_data.json AND is not disabled. null = couldn't determine. */
  appEmbedEnabled: boolean | null;
  /** The embed block exists in settings_data.json but is toggled off. */
  appEmbedPresentButDisabled: boolean;
  /** Whether the inline Try-On app block is present in a product template. null = couldn't determine (e.g. vintage .liquid template). */
  inlineButtonAdded: boolean | null;
  /** Which product template surfaces we could parse. */
  productTemplateParseable: boolean;
  reason: ThemeStatusReason;
  checkedAt: string;
};

// Two-step (the form Shopify's docs verify): find the live theme, then read its
// files. `*` wildcard catches alternate product templates (product.custom.json…).
const MAIN_THEME_QUERY = `#graphql
  query ElloMainTheme {
    themes(first: 1, roles: [MAIN]) {
      nodes { id name }
    }
  }
`;

// We request ALL THREE body variants. Shopify returns large files (a real
// settings_data.json is often 50–200KB) as a URL or base64 — NOT inline text —
// so reading only `content` silently yields nothing. That was the "couldn't
// verify" bug: the read succeeded but every body came back as a URL.
const THEME_FILES_QUERY = `#graphql
  query ElloThemeFiles($id: ID!) {
    theme(id: $id) {
      files(
        filenames: ["config/settings_data.json", "templates/product*.json"]
        first: 50
      ) {
        nodes {
          filename
          body {
            ... on OnlineStoreThemeFileBodyText { content }
            ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
            ... on OnlineStoreThemeFileBodyUrl { url }
          }
        }
      }
    }
  }
`;

type FileBody = { content?: string; contentBase64?: string; url?: string } | null;
type FileNode = { filename: string; body?: FileBody };
type ResolvedFile = { filename: string; content: string | null; bodyKind: string };

// Resolve a theme file's text regardless of how Shopify returned it.
async function resolveFileContent(body: FileBody): Promise<string | null> {
  if (!body) return null;
  if (typeof body.content === "string") return body.content;
  if (typeof body.contentBase64 === "string") {
    try {
      return Buffer.from(body.contentBase64, "base64").toString("utf-8");
    } catch {
      return null;
    }
  }
  if (typeof body.url === "string") {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(body.url, { signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }
  return null;
}

function bodyKind(body: FileBody): string {
  if (body?.content != null) return "text";
  if (body?.contentBase64 != null) return "base64";
  if (body?.url != null) return "url";
  return "none";
}

const THEME_READ_TIMEOUT_MS = 9000;

// Real product page templates: product.json plus alternates product.<name>.json
// / product-<name>.json. Deliberately excludes the wildcard's collateral hits
// like products.json (plural) so we never parse a non-product template.
const PRODUCT_TEMPLATE_RE = /^templates\/product([.-][^/]*)?\.json$/;

// Match a theme app-extension block by its BLOCK HANDLE (the Liquid filename).
// The block `type` is `shopify://apps/{app-handle}/blocks/{handle}/{ext-uuid}`.
// We deliberately match on the block handle and NOT the leading app segment:
// that segment is the app HANDLE (a kebab slug), not the api_key, and it
// differs between the public and custom apps — keying off it would risk false
// NEGATIVES (showing "off" when Ello is actually on) for every merchant, which
// is the exact bug we're fixing. The only residual risk is a false positive if
// another installed app ships an embed block also named "widget"; that's a far
// cheaper failure than a false negative, and "inline-tryon-button" is unique.
function isOurBlock(type: unknown, handle: string): boolean {
  return (
    typeof type === "string" &&
    type.startsWith("shopify://apps/") &&
    type.includes(`/blocks/${handle}/`)
  );
}

// settings_data.json `current` is usually the live settings object, but can be
// a string naming a preset (then the real settings live under presets[name]).
function resolveCurrentSettings(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const current = root.current;
  if (current && typeof current === "object") return current as Record<string, unknown>;
  if (typeof current === "string") {
    const presets = root.presets as Record<string, unknown> | undefined;
    const preset = presets?.[current];
    if (preset && typeof preset === "object") return preset as Record<string, unknown>;
  }
  return null;
}

// Shopify theme JSON files (settings_data.json, templates/*.json) are JSONC:
// they may contain /* … */ comments and trailing commas, which strict
// JSON.parse rejects. Strip those first. This was the second "couldn't verify"
// cause — the files read fine (body=text) but JSON.parse threw on the comments.
function parseThemeJson(raw: string): unknown {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "") // /* block comments */
    .replace(/,(\s*[}\]])/g, "$1"); // trailing commas before } or ]
  return JSON.parse(stripped);
}

function detectAppEmbed(settingsDataContent: string): {
  enabled: boolean | null; // null = file couldn't be parsed (don't claim "off")
  presentButDisabled: boolean;
} {
  try {
    const settings = resolveCurrentSettings(parseThemeJson(settingsDataContent));
    const blocks = (settings?.blocks ?? {}) as Record<string, { type?: unknown; disabled?: unknown }>;
    const ours = Object.values(blocks).filter((b) => isOurBlock(b?.type, APP_EMBED_BLOCK_HANDLE));
    const enabled = ours.some((b) => b?.disabled !== true);
    const presentButDisabled = ours.length > 0 && !enabled;
    return { enabled, presentButDisabled };
  } catch (e) {
    console.warn("[ThemeStatus] settings_data parse failed:", (e as Error).message, "head:", settingsDataContent.slice(0, 100));
    return { enabled: null, presentButDisabled: false };
  }
}

// Recursively look for an enabled block of `handle` anywhere in a parsed theme
// JSON tree. Themes (esp. Horizon) can nest blocks under sections → blocks →
// blocks, so a one-level walk misses them.
function hasEnabledBlock(node: unknown, handle: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => hasEnabledBlock(n, handle));
  const obj = node as Record<string, unknown>;
  if (isOurBlock(obj.type, handle) && obj.disabled !== true) return true;
  return Object.values(obj).some((v) => hasEnabledBlock(v, handle));
}

// true = present & not disabled · false = parsed, not present · null = unparseable.
function detectInlineButton(productTemplateContent: string): boolean | null {
  try {
    const tpl = parseThemeJson(productTemplateContent);
    return hasEnabledBlock(tpl, INLINE_BUTTON_BLOCK_HANDLE);
  } catch (e) {
    console.warn("[ThemeStatus] product template parse failed:", (e as Error).message, "head:", productTemplateContent.slice(0, 100));
    return null;
  }
}

function emptyStatus(reason: ThemeStatusReason): ThemeWidgetStatus {
  return {
    ok: false,
    themeId: null,
    themeName: null,
    appEmbedEnabled: null,
    appEmbedPresentButDisabled: false,
    inlineButtonAdded: null,
    productTemplateParseable: false,
    reason,
    checkedAt: new Date().toISOString(),
  };
}

type GraphqlJson = {
  data?: Record<string, unknown>;
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
};

// Run an Admin GraphQL query, bounded so a slow/stuck Shopify API can't hang
// the dashboard loader.
async function runThemeQuery(
  admin: AdminClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphqlJson> {
  const res = await Promise.race([
    admin.graphql(query, variables ? { variables } : undefined),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("theme-read-timeout")), THEME_READ_TIMEOUT_MS),
    ),
  ]);
  return res.json();
}

function classifyErrors(errors: NonNullable<GraphqlJson["errors"]>): ThemeStatusReason {
  const denied = errors.some(
    (e) =>
      e.extensions?.code === "ACCESS_DENIED" ||
      /access denied|read_themes|not approved|scope/i.test(e.message ?? ""),
  );
  return denied ? "missing_scope" : "graphql_error";
}

/**
 * Read the live theme and report whether the app embed is enabled and the
 * inline button has been added. Never throws — degrades to nulls + a reason.
 */
export async function getThemeWidgetStatus(admin: AdminClient): Promise<ThemeWidgetStatus> {
  // Step 1 — find the published theme.
  let themeJson: GraphqlJson;
  try {
    themeJson = await runThemeQuery(admin, MAIN_THEME_QUERY);
  } catch (err) {
    console.error("[ThemeStatus] theme lookup failed:", err);
    return emptyStatus("graphql_error");
  }
  if (themeJson.errors?.length) {
    console.error("[ThemeStatus] theme lookup errors:", JSON.stringify(themeJson.errors));
    return emptyStatus(classifyErrors(themeJson.errors));
  }
  const themes = themeJson.data?.themes as { nodes?: Array<{ id?: string; name?: string }> } | undefined;
  const theme = themes?.nodes?.[0];
  if (!theme?.id) return emptyStatus("no_published_theme");

  // Step 2 — read the files (all body variants).
  let filesJson: GraphqlJson;
  try {
    filesJson = await runThemeQuery(admin, THEME_FILES_QUERY, { id: theme.id });
  } catch (err) {
    console.error("[ThemeStatus] file read failed:", err);
    return emptyStatus("graphql_error");
  }
  if (filesJson.errors?.length) {
    console.error("[ThemeStatus] file read errors:", JSON.stringify(filesJson.errors));
    return emptyStatus(classifyErrors(filesJson.errors));
  }

  const fileNodes =
    ((filesJson.data?.theme as { files?: { nodes?: FileNode[] } } | undefined)?.files?.nodes) ?? [];
  const resolved: ResolvedFile[] = await Promise.all(
    fileNodes.map(async (f) => ({
      filename: f.filename,
      content: await resolveFileContent(f.body ?? null),
      bodyKind: bodyKind(f.body ?? null),
    })),
  );
  // Diagnostic: which files came back and how (text/base64/url/none) — makes a
  // future "couldn't verify" instantly debuggable from logs.
  console.log(
    `[ThemeStatus] ${theme.name ?? "theme"} → ${
      resolved.map((r) => `${r.filename}=${r.bodyKind}${r.content ? "" : "(empty)"}`).join(", ") || "(no files)"
    }`,
  );

  const settingsFile = resolved.find((f) => f.filename === "config/settings_data.json");
  const productFiles = resolved.filter((f) => PRODUCT_TEMPLATE_RE.test(f.filename));

  // App embed (floating widget). null = file missing or unparseable (unknown).
  let appEmbedEnabled: boolean | null = null;
  let appEmbedPresentButDisabled = false;
  if (settingsFile?.content) {
    const r = detectAppEmbed(settingsFile.content);
    appEmbedEnabled = r.enabled;
    appEmbedPresentButDisabled = r.presentButDisabled;
  }

  // Inline button: added if present in ANY product template JSON. If there are
  // no JSON product templates, the store uses a vintage .liquid template we
  // can't reliably inspect → leave null (unknown), don't claim "not added".
  // If every product template failed to parse, also leave null.
  const productTemplateParseable = productFiles.some((f) => f.content);
  let inlineButtonAdded: boolean | null = null;
  if (productTemplateParseable) {
    let anyParsed = false;
    let found = false;
    for (const f of productFiles) {
      if (!f.content) continue;
      const r = detectInlineButton(f.content);
      if (r === null) continue; // unparseable file — skip
      anyParsed = true;
      if (r) {
        found = true;
        break;
      }
    }
    inlineButtonAdded = found ? true : anyParsed ? false : null;
  }

  return {
    ok: true,
    themeId: theme.id,
    themeName: theme.name ?? null,
    appEmbedEnabled,
    appEmbedPresentButDisabled,
    inlineButtonAdded,
    productTemplateParseable,
    reason: productTemplateParseable ? "ok" : "no_json_product_template",
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Persist the latest theme status to vto_stores so other surfaces (onboarding,
 * billing recap) can show last-known state instantly without a live read.
 * Fire-and-forget; never throws.
 */
export async function persistThemeStatus(
  shopDomain: string,
  status: ThemeWidgetStatus,
): Promise<void> {
  if (!status.ok) return; // don't overwrite good cache with an error result
  const { error } = await supabaseAdmin
    .from("vto_stores")
    .update({
      app_embed_enabled: status.appEmbedEnabled,
      inline_button_added: status.inlineButtonAdded,
      theme_status_checked_at: status.checkedAt,
      theme_status_reason: status.reason,
    })
    .eq("shop_domain", shopDomain);
  if (error) console.error("[ThemeStatus] persist failed (non-fatal):", error.message);
}
