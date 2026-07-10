import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineGrid,
  Text,
  Checkbox,
  TextField,
  Banner,
  Button,
  Box,
  DataTable,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { SectionHeading, Stat } from "../components/ui";

interface LeadRow {
  email: string;
  createdAt: string;
  productId: string | null;
  source: string;
}

// ─── Loader ───────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const { data: store } = await supabaseAdmin
    .from("vto_stores")
    .select("store_slug, lead_capture_enabled, lead_capture_after_n")
    .eq("shop_domain", session.shop)
    .maybeSingle();

  const slug = (store?.store_slug as string | undefined) ?? null;
  if (!slug) {
    return { hasStore: false as const, enabled: false, afterN: 1, total: 0, leads: [] as LeadRow[] };
  }

  const [countRes, rowsRes] = await Promise.all([
    supabaseAdmin
      .from("vto_leads")
      .select("*", { count: "exact", head: true })
      .eq("store_slug", slug),
    supabaseAdmin
      .from("vto_leads")
      .select("email, created_at, product_id, source")
      .eq("store_slug", slug)
      .order("created_at", { ascending: false })
      // 5000 gives ~10× headroom over the old 500 cap so the table AND the CSV
      // export cover any realistic early/mid-stage store. Beyond this a proper
      // streaming export route (cf. app.analytics.export.tsx) is the real fix;
      // the UI surfaces a truncation note when `total` exceeds what's loaded.
      .limit(5000),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (rowsRes.data as any[] | null) ?? [];

  return {
    hasStore: true as const,
    enabled: (store?.lead_capture_enabled as boolean | null) ?? false,
    afterN: (store?.lead_capture_after_n as number | null) ?? 1,
    total: countRes.count ?? rows.length,
    leads: rows.map((r) => ({
      email: String(r.email ?? ""),
      createdAt: String(r.created_at ?? ""),
      productId: r.product_id ? String(r.product_id) : null,
      source: String(r.source ?? "widget"),
    })),
  };
};

// ─── Action ─────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const enabled = form.get("enabled") === "true";
  const rawN = Number.parseInt(String(form.get("after_n") ?? ""), 10);
  const afterN = Number.isFinite(rawN) ? Math.min(10, Math.max(1, rawN)) : 1;

  const { data, error } = await supabaseAdmin
    .from("vto_stores")
    .update({ lead_capture_enabled: enabled, lead_capture_after_n: afterN })
    .eq("shop_domain", session.shop)
    .select("store_slug")
    .maybeSingle();

  if (error) return { ok: false as const, error: error.message };
  if (!data) return { ok: false as const, error: "Store record not found. Finish onboarding first." };
  return { ok: true as const };
};

// ─── Page ─────────────────────────────────────────────────────────────────
export default function Leads() {
  const initial = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [enabled, setEnabled] = useState<boolean>(initial.enabled);
  const [afterN, setAfterN] = useState<string>(String(initial.afterN));

  const saving = fetcher.state !== "idle";
  const saved = fetcher.data?.ok === true;
  const saveError = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;
  const dirty = useMemo(
    () => enabled !== initial.enabled || String(afterN) !== String(initial.afterN),
    [enabled, afterN, initial],
  );

  const handleSave = () => {
    const fd = new FormData();
    fd.set("enabled", String(enabled));
    fd.set("after_n", afterN);
    fetcher.submit(fd, { method: "POST" });
  };

  const exportCsv = () => {
    const header = ["email", "captured_at", "product_id", "source"];
    const escape = (v: string) => {
      // Neutralize spreadsheet formula injection: a cell beginning with = + - @
      // (or tab/CR) is executed as a formula by Excel/Sheets, and lead emails
      // are shopper-controlled. Prefix a single quote so it renders as literal
      // text — CSV quoting alone does NOT stop this. Then apply normal quoting.
      const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
      return `"${guarded.replace(/"/g, '""')}"`;
    };
    const lines = [
      header.join(","),
      ...initial.leads.map((l) =>
        [l.email, l.createdAt, l.productId ?? "", l.source].map((v) => escape(String(v))).join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ello-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const tableRows = initial.leads.map((l) => [
    l.email,
    new Date(l.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    l.source,
  ]);

  return (
    <Page
      title="Leads"
      subtitle="Turn try-on sessions into a growing email list."
      primaryAction={{ content: "Save changes", onAction: handleSave, loading: saving, disabled: !dirty }}
      secondaryActions={[{ content: "Export CSV", onAction: exportCsv, disabled: initial.leads.length === 0 }]}
    >
      <BlockStack gap="500">
        {saved && !dirty && <Banner tone="success">Settings saved. The widget updates on shoppers&apos; next visit.</Banner>}
        {saveError && <Banner tone="critical">{saveError}</Banner>}
        {!initial.hasStore && (
          <Banner tone="warning">We couldn&apos;t find your store record yet. Finish onboarding to capture leads.</Banner>
        )}

        <InlineGrid columns={{ xs: "1fr", sm: "1fr 1fr" }} gap="400">
          <Stat label="Total leads" value={initial.total.toLocaleString()} hint="All time" accent />
          <Stat
            label="Capture"
            value={initial.enabled ? "On" : "Off"}
            hint={initial.enabled ? `After ${initial.afterN} try-on${initial.afterN === 1 ? "" : "s"}` : "Currently disabled"}
          />
        </InlineGrid>

        <Card padding="500">
          <BlockStack gap="400">
            <SectionHeading
              eyebrow="Capture"
              title="Email capture"
              description="A one-time, dismissible prompt while shoppers try things on. It never blocks the result."
            />
            <Checkbox label="Capture emails from shoppers" checked={enabled} onChange={setEnabled} />
            <Box maxWidth="280px">
              <TextField
                label="Ask after this many try-ons"
                type="number"
                value={afterN}
                onChange={setAfterN}
                autoComplete="off"
                min={1}
                max={10}
                disabled={!enabled}
                helpText="1 asks after the first try-on. Higher lets shoppers explore a few looks first."
              />
            </Box>
          </BlockStack>
        </Card>

        <Card padding="500">
          <BlockStack gap="400">
            <SectionHeading
              eyebrow="Your list"
              title="Captured emails"
              action={initial.leads.length > 0 ? <Button variant="plain" onClick={exportCsv}>Export CSV</Button> : undefined}
            />
            {tableRows.length === 0 ? (
              <Box paddingBlock="400">
                <Text as="p" tone="subdued">No emails captured yet. Turn on capture above and they&apos;ll appear here.</Text>
              </Box>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text"]}
                headings={["Email", "Captured", "Source"]}
                rows={tableRows}
              />
            )}
            {initial.total > initial.leads.length && (
              <Text as="p" variant="bodySm" tone="subdued">
                Showing the {initial.leads.length.toLocaleString()} most recent of{" "}
                {initial.total.toLocaleString()} leads. The CSV export covers this same set —
                contact us if you need the full history.
              </Text>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
