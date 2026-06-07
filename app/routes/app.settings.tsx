import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Checkbox,
  Banner,
  Button,
  Box,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";

const OVERAGE_RATE = 0.15; // USD per try-on (mirrors api.overage-settings.tsx)

// ─── Loader ───────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const { data } = await supabaseAdmin
    .from("vto_stores")
    .select(
      "store_slug, overage_auto_topup, overage_cap_credits, overage_credits_used",
    )
    .eq("shop_domain", session.shop)
    .maybeSingle();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any;

  return {
    hasStore: !!row,
    autoTopup: row?.overage_auto_topup ?? false,
    capCredits: row?.overage_cap_credits ?? null,
    creditsUsed: row?.overage_credits_used ?? 0,
  };
};

// ─── Action ─────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const autoTopup = form.get("auto_topup") === "true";

  const { data, error } = await supabaseAdmin
    .from("vto_stores")
    .update({ overage_auto_topup: autoTopup })
    .eq("shop_domain", session.shop)
    .select("store_slug")
    .maybeSingle();

  if (error) return { ok: false as const, error: error.message };
  if (!data) {
    return {
      ok: false as const,
      error: "Store record not found. Finish onboarding, then try again.",
    };
  }
  return { ok: true as const };
};

// ─── Page ─────────────────────────────────────────────────────────────────
export default function Settings() {
  const initial = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();

  const [autoTopup, setAutoTopup] = useState<boolean>(initial.autoTopup);

  const saving = fetcher.state !== "idle";
  const saved = fetcher.data?.ok === true;
  const saveError = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;
  const dirty = useMemo(() => autoTopup !== initial.autoTopup, [autoTopup, initial.autoTopup]);

  const handleSave = () => {
    const fd = new FormData();
    fd.set("auto_topup", String(autoTopup));
    fetcher.submit(fd, { method: "POST" });
  };

  const money = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

  return (
    <Page
      title="Settings"
      subtitle="Manage overages and your plan."
      primaryAction={{ content: "Save", onAction: handleSave, loading: saving, disabled: !dirty }}
    >
      <BlockStack gap="400">
        {saved && !dirty && <Banner tone="success">Settings saved.</Banner>}
        {saveError && <Banner tone="critical">{saveError}</Banner>}
        {!initial.hasStore && (
          <Banner tone="warning">
            We couldn&apos;t find your store record yet. Finish onboarding to manage settings.
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {/* Overages */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Overages</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Overages let try-ons keep working after you reach your plan&apos;s monthly
                    included amount, billed at {money(OVERAGE_RATE)} per try-on up to your spend cap.
                  </Text>
                  <Checkbox
                    label="Allow overages beyond my plan"
                    helpText="Turn off to stop try-ons once the monthly included amount is used."
                    checked={autoTopup}
                    onChange={setAutoTopup}
                  />
                  <Divider />
                  <InlineStack align="space-between">
                    <Text as="span" variant="bodySm" tone="subdued">Overage rate</Text>
                    <Text as="span" variant="bodySm">{money(OVERAGE_RATE)} / try-on</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span" variant="bodySm" tone="subdued">Overage try-ons used this period</Text>
                    <Text as="span" variant="bodySm">{Number(initial.creditsUsed).toLocaleString()}</Text>
                  </InlineStack>
                  <InlineStack align="space-between">
                    <Text as="span" variant="bodySm" tone="subdued">Spend cap</Text>
                    <Text as="span" variant="bodySm">
                      {initial.capCredits != null
                        ? `${Number(initial.capCredits).toLocaleString()} try-ons (${money(Number(initial.capCredits) * OVERAGE_RATE)})`
                        : "Not set"}
                    </Text>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Your spend cap is tied to your Shopify subscription — adjust it from Billing.
                  </Text>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          {/* Plan aside */}
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Plan</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Change your plan, view included try-ons, and manage your spend cap.
                </Text>
                <Box>
                  <Button onClick={() => navigate("/app/billing")}>Manage billing</Button>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
