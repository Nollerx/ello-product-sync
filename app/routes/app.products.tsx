import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Button,
  Tag,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { resolveStorefront, fetchStorefrontProducts } from "../lib/storefront-names.server";
import { SectionHeading, brand } from "../components/ui";

type Mode = "all" | "products" | "collections";
interface ProductItem {
  id: string;
  title: string;
  featuredImage: string | null;
  images: string[];
  active: boolean;
  overrideUrl: string | null;
}
interface Picked {
  id: string;
  title: string;
}

// ─── Loader ───────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const { data: store } = await supabaseAdmin
    .from("vto_stores")
    .select(
      "store_slug, shop_domain, storefront_token, tryon_targeting_mode, tryon_included_product_ids, tryon_included_collection_ids",
    )
    .eq("shop_domain", session.shop)
    .maybeSingle();

  if (!store) {
    return {
      hasStore: false as const,
      mode: "all" as Mode,
      products: [] as ProductItem[],
      collections: [] as Picked[],
      overridden: [] as ProductItem[],
    };
  }

  const mode = ((store.tryon_targeting_mode as string | null) || "all") as Mode;
  const productIds = Array.isArray(store.tryon_included_product_ids) ? (store.tryon_included_product_ids as string[]) : [];
  const collectionIds = Array.isArray(store.tryon_included_collection_ids) ? (store.tryon_included_collection_ids as string[]) : [];
  const shopDomain = (store.shop_domain as string | null) ?? null;
  const token = (store.storefront_token as string | null) ?? null;
  const slug = store.store_slug as string;

  let products: ProductItem[] = [];
  if (productIds.length > 0) {
    const [sfp, ciRes] = await Promise.all([
      fetchStorefrontProducts(shopDomain, token, productIds),
      supabaseAdmin
        .from("clothing_items")
        .select("item_id, active, image_override_url")
        .eq("store_id", slug)
        .in("item_id", productIds),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ciMap = new Map((ciRes.data as any[] | null ?? []).map((r) => [String(r.item_id), r]));
    products = productIds.map((id) => {
      const p = sfp.get(id);
      const c = ciMap.get(id);
      return {
        id,
        title: p?.title ?? id,
        featuredImage: p?.featuredImage ?? null,
        images: p?.images ?? [],
        active: c ? c.active !== false : true,
        overrideUrl: (c?.image_override_url as string | null) ?? null,
      };
    });
  }

  let collections: Picked[] = [];
  if (collectionIds.length > 0) {
    const { titles } = await resolveStorefront(shopDomain, token, collectionIds);
    collections = collectionIds.map((id) => ({ id, title: titles.get(id) ?? id }));
  }

  // Custom try-on photos live in clothing_items independent of targeting, so
  // merchants on "all"/"collections" can manage them too. Only gid rows are
  // editable here — synced rows with other id formats are left alone.
  const { data: ovRows } = await supabaseAdmin
    .from("clothing_items")
    .select("item_id, image_override_url")
    .eq("store_id", slug)
    .not("image_override_url", "is", null);
  const ovIds = (ovRows ?? [])
    .map((r) => String(r.item_id))
    .filter((id) => id.startsWith("gid://"));

  let overridden: ProductItem[] = [];
  if (ovIds.length > 0) {
    const ovMap = new Map((ovRows ?? []).map((r) => [String(r.item_id), (r.image_override_url as string | null) ?? null]));
    const sfp = await fetchStorefrontProducts(shopDomain, token, ovIds);
    overridden = ovIds.map((id) => {
      const p = sfp.get(id);
      return {
        id,
        title: p?.title ?? id,
        featuredImage: p?.featuredImage ?? null,
        images: p?.images ?? [],
        active: true,
        overrideUrl: ovMap.get(id) ?? null,
      };
    });
  }

  return { hasStore: true as const, mode, products, collections, overridden };
};

// ─── Action ─────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const mode = String(form.get("mode") ?? "all") as Mode;
  if (!["all", "products", "collections"].includes(mode)) {
    return { ok: false as const, error: "Invalid targeting mode." };
  }

  const parseIds = (key: string): string[] => {
    try {
      const v = JSON.parse(String(form.get(key) ?? "[]"));
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  const productIds = parseIds("product_ids");
  const collectionIds = parseIds("collection_ids");

  let overrides: Array<{ item_id: string; override_url: string | null }> = [];
  try {
    const v = JSON.parse(String(form.get("overrides") ?? "[]"));
    if (Array.isArray(v)) {
      overrides = v
        .filter((o) => o && typeof o.item_id === "string")
        .map((o) => ({ item_id: o.item_id as string, override_url: (o.override_url as string | null) ?? null }));
    }
  } catch {
    overrides = [];
  }

  if (mode === "products" && productIds.length === 0) {
    return { ok: false as const, error: "Select at least one product, or choose “All clothing”." };
  }
  if (mode === "collections" && collectionIds.length === 0) {
    return { ok: false as const, error: "Select at least one collection, or choose “All clothing”." };
  }

  const { data: store } = await supabaseAdmin
    .from("vto_stores")
    .select("store_slug, shop_domain, storefront_token, config_version")
    .eq("shop_domain", session.shop)
    .maybeSingle();

  if (!store) {
    return { ok: false as const, error: "Store record not found. Finish onboarding, then try again." };
  }
  const slug = store.store_slug as string;

  const { error: updErr } = await supabaseAdmin
    .from("vto_stores")
    .update({
      tryon_targeting_mode: mode,
      tryon_included_product_ids: productIds,
      tryon_included_collection_ids: collectionIds,
      config_version: (Number(store.config_version) || 0) + 1,
    })
    .eq("shop_domain", session.shop);

  if (updErr) return { ok: false as const, error: updErr.message };

  if (overrides.length > 0) {
    const sfp = await fetchStorefrontProducts(
      (store.shop_domain as string | null) ?? null,
      (store.storefront_token as string | null) ?? null,
      overrides.map((o) => o.item_id),
    );
    const rows = overrides.map((o) => {
      const p = sfp.get(o.item_id);
      return {
        store_id: slug,
        item_id: o.item_id,
        name: p?.title ?? "Product",
        price: p?.price ?? 0,
        category: p?.category ?? "clothing",
        data_source: "shopify",
        image_override_url: o.override_url || null,
      };
    });
    const { error: ciErr } = await supabaseAdmin
      .from("clothing_items")
      .upsert(rows, { onConflict: "store_id,item_id" });
    if (ciErr) return { ok: false as const, error: ciErr.message };
  }

  return { ok: true as const };
};

// ─── Mode card ──────────────────────────────────────────────────────────────
function ModeCard({ active, title, desc, onClick }: { active: boolean; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        textAlign: "left",
        width: "100%",
        cursor: "pointer",
        border: active ? `2px solid ${brand.blue}` : `1px solid ${brand.ink200}`,
        background: active ? brand.blue50 : brand.white,
        borderRadius: 14,
        padding: 18,
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        transition: "border-color 120ms ease, background 120ms ease",
        boxShadow: active ? "0 4px 14px rgba(59,99,212,0.12)" : "none",
      }}
    >
      <span
        aria-hidden
        style={{
          marginTop: 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          flexShrink: 0,
          background: brand.white,
          border: active ? `5px solid ${brand.blue}` : `2px solid ${brand.ink200}`,
        }}
      />
      <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontWeight: 600, fontSize: 15, color: brand.ink }}>{title}</span>
        <span style={{ fontSize: 13, lineHeight: 1.45, color: brand.ink500 }}>{desc}</span>
      </span>
    </button>
  );
}

function Thumb({ url }: { url: string | null }) {
  return (
    <div
      style={{
        width: 52,
        height: 52,
        borderRadius: 10,
        flexShrink: 0,
        background: url ? `center / cover no-repeat url(${JSON.stringify(url)})` : brand.ink100,
        border: `1px solid ${brand.ink100}`,
      }}
    />
  );
}

// ─── Product row with inline try-on image picker ────────────────────────────
function ProductRow({
  p,
  override,
  onSelectImage,
  onReset,
  onRemove,
}: {
  p: ProductItem;
  override: string | null;
  onSelectImage: (url: string) => void;
  onReset: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const current = override ?? p.featuredImage;
  const hasOverride = override != null && override !== p.featuredImage;

  return (
    <div style={{ border: `1px solid ${brand.ink100}`, borderRadius: 14, background: brand.white, padding: 14 }}>
      <InlineStack align="space-between" blockAlign="center" wrap={false}>
        <InlineStack gap="300" blockAlign="center">
          <Thumb url={current} />
          <BlockStack gap="100">
            <Text as="span" variant="bodyMd" fontWeight="medium">{p.title}</Text>
            {hasOverride && <Text as="span" variant="bodySm" tone="subdued">Custom try-on photo</Text>}
          </BlockStack>
        </InlineStack>
        <InlineStack gap="100" blockAlign="center">
          {p.images.length > 1 && (
            <Button variant="tertiary" onClick={() => setOpen((o) => !o)}>{open ? "Done" : "Try-on photo"}</Button>
          )}
          <Button variant="tertiary" tone="critical" onClick={onRemove} accessibilityLabel={`Remove ${p.title}`}>Remove</Button>
        </InlineStack>
      </InlineStack>

      {open && p.images.length > 0 && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${brand.ink100}`, paddingTop: 14 }}>
          <Text as="p" variant="bodySm" tone="subdued">Pick the clearest front-facing photo — it&apos;s what the try-on renders from.</Text>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
            {p.images.map((url, i) => {
              const selected = (override ?? p.featuredImage) === url;
              const isFeatured = i === 0;
              return (
                <button
                  key={url + i}
                  type="button"
                  onClick={() => (isFeatured ? onReset() : onSelectImage(url))}
                  style={{
                    position: "relative",
                    width: 64,
                    height: 82,
                    padding: 0,
                    overflow: "hidden",
                    cursor: "pointer",
                    borderRadius: 10,
                    border: selected ? `2px solid ${brand.blue}` : `1px solid ${brand.ink200}`,
                    background: brand.white,
                  }}
                >
                  <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  {isFeatured && (
                    <span style={{ position: "absolute", bottom: 0, left: 0, right: 0, fontSize: 9, fontWeight: 600, background: "rgba(11,18,32,0.72)", color: "#fff", textAlign: "center", padding: "2px 0" }}>
                      Default
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const toUrl = (img: { url?: string; originalSrc?: string; src?: string }) => img.url ?? img.originalSrc ?? img.src ?? null;

// ─── Page ─────────────────────────────────────────────────────────────────
export default function Products() {
  const initial = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [mode, setMode] = useState<Mode>(initial.mode);
  const [products, setProducts] = useState<ProductItem[]>(initial.products);
  const [collections, setCollections] = useState<Picked[]>(initial.collections);
  const [photoProducts, setPhotoProducts] = useState<ProductItem[]>(initial.overridden);
  const [overrides, setOverrides] = useState<Record<string, string | null>>(
    () => Object.fromEntries([...initial.products, ...initial.overridden].map((p) => [p.id, p.overrideUrl])),
  );

  const initialOverrides = useMemo(
    () => Object.fromEntries([...initial.products, ...initial.overridden].map((p) => [p.id, p.overrideUrl])),
    [initial.products, initial.overridden],
  );

  // Overrides can be edited from either list (targeted rows or the photos
  // card), so diff and save across the union.
  const tracked = useMemo(() => {
    const m = new Map<string, ProductItem>();
    [...products, ...photoProducts].forEach((p) => m.set(p.id, p));
    return [...m.values()];
  }, [products, photoProducts]);

  const saving = fetcher.state !== "idle";
  const saved = fetcher.data?.ok === true;
  const saveError = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  const sameIds = (a: { id: string }[], b: { id: string }[]) =>
    a.map((x) => x.id).sort().join(",") === b.map((x) => x.id).sort().join(",");

  const overridesChanged = useMemo(
    () => tracked.some((p) => (overrides[p.id] ?? null) !== (initialOverrides[p.id] ?? null)),
    [tracked, overrides, initialOverrides],
  );

  const dirty = useMemo(
    () =>
      mode !== initial.mode ||
      !sameIds(products, initial.products) ||
      !sameIds(collections, initial.collections) ||
      overridesChanged,
    [mode, products, collections, overridesChanged, initial],
  );

  const pickProducts = async () => {
    const picker = window.shopify?.resourcePicker;
    if (!picker) return;
    const sel = await picker({ type: "product", multiple: true, selectionIds: products.map((p) => ({ id: p.id })) });
    if (!sel) return;
    setProducts(
      sel.map((r) => {
        const existing = products.find((p) => p.id === r.id);
        const imgs = (r.images ?? []).map(toUrl).filter((u): u is string => Boolean(u));
        return {
          id: r.id,
          title: r.title ?? r.id,
          featuredImage: existing?.featuredImage ?? imgs[0] ?? null,
          images: existing?.images.length ? existing.images : imgs,
          active: existing?.active ?? true,
          overrideUrl: existing?.overrideUrl ?? null,
        };
      }),
    );
  };

  const pickCollections = async () => {
    const picker = window.shopify?.resourcePicker;
    if (!picker) return;
    const sel = await picker({ type: "collection", multiple: true, selectionIds: collections.map((c) => ({ id: c.id })) });
    if (sel) setCollections(sel.map((r) => ({ id: r.id, title: r.title ?? r.id })));
  };

  const pickPhotoProducts = async () => {
    const picker = window.shopify?.resourcePicker;
    if (!picker) return;
    const sel = await picker({ type: "product", multiple: true, selectionIds: photoProducts.map((p) => ({ id: p.id })) });
    if (!sel) return;
    const kept = new Set(sel.map((r) => r.id));
    setOverrides((prev) => {
      const next = { ...prev };
      photoProducts.forEach((p) => {
        if (!kept.has(p.id)) next[p.id] = null;
      });
      return next;
    });
    setPhotoProducts(
      sel.map((r) => {
        const existing = photoProducts.find((p) => p.id === r.id) ?? products.find((p) => p.id === r.id);
        const imgs = (r.images ?? []).map(toUrl).filter((u): u is string => Boolean(u));
        return {
          id: r.id,
          title: r.title ?? r.id,
          featuredImage: existing?.featuredImage ?? imgs[0] ?? null,
          images: existing?.images.length ? existing.images : imgs,
          active: true,
          overrideUrl: existing?.overrideUrl ?? null,
        };
      }),
    );
  };

  const removePhotoProduct = (id: string) => {
    setPhotoProducts((prev) => prev.filter((x) => x.id !== id));
    setOverrides((prev) => ({ ...prev, [id]: null }));
  };

  const handleSave = () => {
    const changed = tracked
      .filter((p) => (overrides[p.id] ?? null) !== (initialOverrides[p.id] ?? null))
      .map((p) => ({ item_id: p.id, override_url: overrides[p.id] ?? null }));

    const fd = new FormData();
    fd.set("mode", mode);
    fd.set("product_ids", JSON.stringify(products.map((p) => p.id)));
    fd.set("collection_ids", JSON.stringify(collections.map((c) => c.id)));
    fd.set("overrides", JSON.stringify(changed));
    fetcher.submit(fd, { method: "POST" });
  };

  const summary =
    mode === "all"
      ? "Try-on shows on all products."
      : mode === "products"
        ? `Try-on shows on ${products.length} selected product${products.length === 1 ? "" : "s"}.`
        : `Try-on shows on products in ${collections.length} collection${collections.length === 1 ? "" : "s"}.`;

  return (
    <Page
      title="Products"
      subtitle="Choose where Try-On appears and which photo each product renders from."
      primaryAction={{ content: "Save changes", onAction: handleSave, loading: saving, disabled: !dirty }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto", width: "100%" }}>
        <BlockStack gap="500">
          {saved && !dirty && <Banner tone="success">Saved. Your storefront updates within about 30 seconds.</Banner>}
          {saveError && <Banner tone="critical">{saveError}</Banner>}
          {!initial.hasStore && (
            <Banner tone="warning">We couldn&apos;t find your store record yet. Finish onboarding to manage products.</Banner>
          )}

          <Card padding="500">
            <BlockStack gap="500">
              <SectionHeading
                eyebrow="Coverage"
                title="Where should Try-On appear?"
                description="Scope the experience to your whole catalog or just the pieces you choose."
              />

              <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                <ModeCard active={mode === "all"} title="All clothing" desc="Show Try-On on every product." onClick={() => setMode("all")} />
                <ModeCard active={mode === "products"} title="Select clothing" desc="Pick specific products that can be tried on." onClick={() => setMode("products")} />
                <ModeCard active={mode === "collections"} title="By collection" desc="Show Try-On on every product in chosen collections." onClick={() => setMode("collections")} />
              </InlineGrid>

              {mode === "products" && (
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="span" variant="headingSm">Products</Text>
                    <Button onClick={pickProducts}>{products.length > 0 ? "Edit selection" : "Select products"}</Button>
                  </InlineStack>
                  {products.length === 0 ? (
                    <div style={{ border: `1px solid ${brand.ink100}`, borderRadius: 14, background: brand.offwhite, padding: 18 }}>
                      <Text as="p" tone="subdued" variant="bodySm">No products selected yet. Click “Select products” to pick from your catalog.</Text>
                    </div>
                  ) : (
                    <BlockStack gap="200">
                      {products.map((p) => (
                        <ProductRow
                          key={p.id}
                          p={p}
                          override={overrides[p.id] ?? null}
                          onSelectImage={(url) => setOverrides((prev) => ({ ...prev, [p.id]: url }))}
                          onReset={() => setOverrides((prev) => ({ ...prev, [p.id]: null }))}
                          onRemove={() => setProducts((prev) => prev.filter((x) => x.id !== p.id))}
                        />
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              )}

              {mode === "collections" && (
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="span" variant="headingSm">Collections</Text>
                    <Button onClick={pickCollections}>{collections.length > 0 ? "Edit" : "Select"}</Button>
                  </InlineStack>
                  {collections.length === 0 ? (
                    <div style={{ border: `1px solid ${brand.ink100}`, borderRadius: 14, background: brand.offwhite, padding: 18 }}>
                      <Text as="p" tone="subdued" variant="bodySm">No collections selected yet. Click “Select” to choose from your store.</Text>
                    </div>
                  ) : (
                    <div style={{ border: `1px solid ${brand.ink100}`, borderRadius: 14, background: brand.offwhite, padding: 18 }}>
                      <InlineStack gap="200" wrap>
                        {collections.map((c) => (
                          <Tag key={c.id} onRemove={() => setCollections((prev) => prev.filter((x) => x.id !== c.id))}>{c.title}</Tag>
                        ))}
                      </InlineStack>
                    </div>
                  )}
                </BlockStack>
              )}

              <div style={{ borderTop: `1px solid ${brand.ink100}`, paddingTop: 16, display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: brand.success, flexShrink: 0 }} />
                <Text as="span" variant="bodySm" tone="subdued">{summary}</Text>
              </div>
            </BlockStack>
          </Card>

          {/* In "products" mode the per-row picker above covers this; for
              "all"/"collections" this card is the only way to set photos. */}
          {mode !== "products" && (
            <Card padding="500">
              <BlockStack gap="400">
                <SectionHeading
                  eyebrow="Try-on photos"
                  title="Custom try-on photos"
                  description="Try-on renders from each product's featured image. If another shot works better — clearer, front-facing, on a model — set it here. This doesn't change where Try-On appears."
                />
                <InlineStack>
                  <Button onClick={pickPhotoProducts}>
                    {photoProducts.length > 0 ? "Edit products" : "Choose products"}
                  </Button>
                </InlineStack>
                {photoProducts.length === 0 ? (
                  <div style={{ border: `1px solid ${brand.ink100}`, borderRadius: 14, background: brand.offwhite, padding: 18 }}>
                    <Text as="p" tone="subdued" variant="bodySm">
                      No custom photos yet. Choose a product, then pick which of its photos the try-on should use.
                    </Text>
                  </div>
                ) : (
                  <BlockStack gap="200">
                    {photoProducts.map((p) => (
                      <ProductRow
                        key={p.id}
                        p={p}
                        override={overrides[p.id] ?? null}
                        onSelectImage={(url) => setOverrides((prev) => ({ ...prev, [p.id]: url }))}
                        onReset={() => setOverrides((prev) => ({ ...prev, [p.id]: null }))}
                        onRemove={() => removePhotoProduct(p.id)}
                      />
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          )}
        </BlockStack>
      </div>
    </Page>
  );
}
