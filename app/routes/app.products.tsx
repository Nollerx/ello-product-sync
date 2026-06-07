import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  ChoiceList,
  Button,
  Tag,
  Banner,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";

type Mode = "all" | "products" | "collections";
interface Picked {
  id: string;
  title: string;
}

// ─── Loader ───────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const { data: store } = await supabaseAdmin
    .from("vto_stores")
    .select(
      "store_slug, tryon_targeting_mode, tryon_included_product_ids, tryon_included_collection_ids",
    )
    .eq("shop_domain", session.shop)
    .maybeSingle();

  if (!store) {
    return { hasStore: false as const, mode: "all" as Mode, products: [] as Picked[], collections: [] as Picked[] };
  }

  const mode = ((store.tryon_targeting_mode as string | null) || "all") as Mode;
  const productIds = Array.isArray(store.tryon_included_product_ids)
    ? (store.tryon_included_product_ids as string[])
    : [];
  const collectionIds = Array.isArray(store.tryon_included_collection_ids)
    ? (store.tryon_included_collection_ids as string[])
    : [];

  // Resolve display titles for the saved selections (best-effort).
  const allIds = [...productIds, ...collectionIds];
  const titleById = new Map<string, string>();
  if (allIds.length > 0) {
    try {
      const resp = await admin.graphql(
        `#graphql
        query PickedTitles($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product { id title }
            ... on Collection { id title }
          }
        }`,
        { variables: { ids: allIds } },
      );
      const json = await resp.json();
      for (const node of json?.data?.nodes ?? []) {
        if (node?.id && node?.title) titleById.set(node.id, node.title);
      }
    } catch (err) {
      console.error("[products] title lookup failed (non-fatal):", err);
    }
  }

  return {
    hasStore: true as const,
    mode,
    products: productIds.map((id) => ({ id, title: titleById.get(id) ?? id })),
    collections: collectionIds.map((id) => ({ id, title: titleById.get(id) ?? id })),
  };
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

  if (mode === "products" && productIds.length === 0) {
    return { ok: false as const, error: "Select at least one product, or choose “All clothing”." };
  }
  if (mode === "collections" && collectionIds.length === 0) {
    return { ok: false as const, error: "Select at least one collection, or choose “All clothing”." };
  }

  const { data, error } = await supabaseAdmin
    .from("vto_stores")
    .update({
      tryon_targeting_mode: mode,
      // Persist both lists so switching modes doesn't lose the other selection.
      tryon_included_product_ids: productIds,
      tryon_included_collection_ids: collectionIds,
    })
    .eq("shop_domain", session.shop)
    .select("store_slug")
    .maybeSingle();

  if (error) return { ok: false as const, error: error.message };
  if (!data) {
    return { ok: false as const, error: "Store record not found. Finish onboarding, then try again." };
  }
  return { ok: true as const };
};

// ─── Selected-items list ──────────────────────────────────────────────────
function SelectionTags({
  items,
  onRemove,
  emptyText,
}: {
  items: Picked[];
  onRemove: (id: string) => void;
  emptyText: string;
}) {
  if (items.length === 0) {
    return <Text as="p" tone="subdued" variant="bodySm">{emptyText}</Text>;
  }
  return (
    <InlineStack gap="200" wrap>
      {items.map((it) => (
        <Tag key={it.id} onRemove={() => onRemove(it.id)}>{it.title}</Tag>
      ))}
    </InlineStack>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────
export default function Products() {
  const initial = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [mode, setMode] = useState<Mode>(initial.mode);
  const [products, setProducts] = useState<Picked[]>(initial.products);
  const [collections, setCollections] = useState<Picked[]>(initial.collections);

  const saving = fetcher.state !== "idle";
  const saved = fetcher.data?.ok === true;
  const saveError = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  const idsEqual = (a: Picked[], b: Picked[]) =>
    a.map((x) => x.id).sort().join(",") === b.map((x) => x.id).sort().join(",");
  const dirty = useMemo(
    () =>
      mode !== initial.mode ||
      !idsEqual(products, initial.products) ||
      !idsEqual(collections, initial.collections),
    [mode, products, collections, initial],
  );

  const pickProducts = async () => {
    const picker = window.shopify?.resourcePicker;
    if (!picker) return;
    const sel = await picker({
      type: "product",
      multiple: true,
      selectionIds: products.map((p) => ({ id: p.id })),
    });
    if (sel) setProducts(sel.map((r) => ({ id: r.id, title: r.title ?? r.id })));
  };

  const pickCollections = async () => {
    const picker = window.shopify?.resourcePicker;
    if (!picker) return;
    const sel = await picker({
      type: "collection",
      multiple: true,
      selectionIds: collections.map((c) => ({ id: c.id })),
    });
    if (sel) setCollections(sel.map((r) => ({ id: r.id, title: r.title ?? r.id })));
  };

  const handleSave = () => {
    const fd = new FormData();
    fd.set("mode", mode);
    fd.set("product_ids", JSON.stringify(products.map((p) => p.id)));
    fd.set("collection_ids", JSON.stringify(collections.map((c) => c.id)));
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
      subtitle="Choose which products show the Try-On button."
      primaryAction={{ content: "Save", onAction: handleSave, loading: saving, disabled: !dirty }}
    >
      <BlockStack gap="400">
        {saved && !dirty && <Banner tone="success">Saved. Your storefront updates within about 30 seconds.</Banner>}
        {saveError && <Banner tone="critical">{saveError}</Banner>}
        {!initial.hasStore && (
          <Banner tone="warning">We couldn&apos;t find your store record yet. Finish onboarding to manage products.</Banner>
        )}

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <ChoiceList
                    title="Where should Try-On appear?"
                    choices={[
                      { label: "All clothing", value: "all", helpText: "Show the Try-On button on every product." },
                      { label: "Select clothing", value: "products", helpText: "Pick specific products that can be tried on." },
                      { label: "By collection", value: "collections", helpText: "Show Try-On on every product inside the collections you choose." },
                    ]}
                    selected={[mode]}
                    onChange={(v) => setMode((v[0] as Mode) ?? "all")}
                  />

                  {mode === "products" && (
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h2" variant="headingSm">Selected products</Text>
                        <Button onClick={pickProducts}>
                          {products.length > 0 ? "Edit products" : "Select products"}
                        </Button>
                      </InlineStack>
                      <SelectionTags
                        items={products}
                        onRemove={(id) => setProducts((prev) => prev.filter((p) => p.id !== id))}
                        emptyText="No products selected yet. Click “Select products” to pick from your catalog."
                      />
                    </BlockStack>
                  )}

                  {mode === "collections" && (
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h2" variant="headingSm">Selected collections</Text>
                        <Button onClick={pickCollections}>
                          {collections.length > 0 ? "Edit collections" : "Select collections"}
                        </Button>
                      </InlineStack>
                      <SelectionTags
                        items={collections}
                        onRemove={(id) => setCollections((prev) => prev.filter((c) => c.id !== id))}
                        emptyText="No collections selected yet. Click “Select collections” to choose from your store."
                      />
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Current coverage</Text>
                <Text as="p" tone="subdued">{summary}</Text>
                <Box paddingBlockStart="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Products you specifically hide always stay hidden, even inside a chosen collection.
                  </Text>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
