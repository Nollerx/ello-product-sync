import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Banner,
  Button,
  ProgressBar,
  TextField,
  Select,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { getPlanConfig } from "../lib/shopify-billing.server";
import { SectionHeading, brand } from "../components/ui";
import { LineSeries } from "../components/analytics";
import { dailySeries } from "../lib/analytics.server";

const OVERAGE_RATE = 0.15; // USD per try-on (mirrors api.overage-settings.tsx)

// ─── Loader ───────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const { data } = await supabaseAdmin
    .from("vto_stores")
    .select(
      "store_slug, account_id, overage_auto_topup, overage_cap_credits, overage_credits_used, shopper_limit_enabled, shopper_limit_count, shopper_limit_window_hours",
    )
    .eq("shop_domain", session.shop)
    .maybeSingle();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any;

  // Current billing period + plan, for the usage forecast.
  let tryonsUsed = 0;
  let includedTryons: number | null = null;
  let planDisplayName: string | null = null;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let daily: Array<{ day: string; count: number }> = [];

  if (row?.account_id) {
    const { data: sub } = await supabaseAdmin
      .from("vto_subscriptions")
      .select("id, plan_id")
      .eq("account_id", row.account_id)
      .eq("status", "active")
      .order("shopify_subscription_id", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (sub) {
      const entry = Object.entries(getPlanConfig()).find(([, m]) => m.planId === sub.plan_id);
      if (entry) {
        planDisplayName = entry[1].displayName;
        includedTryons = entry[1].includedTryons;
      }
      const now = new Date().toISOString();
      const { data: period } = await supabaseAdmin
        .from("vto_usage_periods")
        .select("tryons_used, period_start, period_end")
        .eq("subscription_id", sub.id)
        .lte("period_start", now)
        .gte("period_end", now)
        .maybeSingle();
      if (period) {
        tryonsUsed = Number(period.tryons_used ?? 0);
        periodStart = String(period.period_start);
        periodEnd = String(period.period_end);

        const { data: events } = await supabaseAdmin
          .from("tryon_events")
          .select("created_at")
          .eq("store_slug", row.store_slug)
          .gte("created_at", periodStart)
          .lt("created_at", now)
          .order("created_at", { ascending: false })
          .limit(10000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dates = ((events as any[] | null) ?? []).map((e) => String(e.created_at));
        daily = dailySeries(dates, "UTC", new Date(periodStart), new Date());
      }
    }
  }

  return {
    hasStore: !!row,
    autoTopup: row?.overage_auto_topup ?? false,
    capCredits: row?.overage_cap_credits ?? null,
    creditsUsed: row?.overage_credits_used ?? 0,
    shopperLimitEnabled: row?.shopper_limit_enabled ?? false,
    shopperLimitCount: row?.shopper_limit_count ?? 15,
    shopperLimitWindowHours: row?.shopper_limit_window_hours ?? 24,
    tryonsUsed,
    includedTryons,
    planDisplayName,
    periodStart,
    periodEnd,
    daily,
    // eslint-disable-next-line no-undef
    skipBilling: process.env.SKIP_BILLING === "true",
  };
};

// ─── Action ─────────────────────────────────────────────────────────────────
const SHOPPER_LIMIT_WINDOWS = [1, 6, 12, 24, 168];

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const autoTopup = form.get("auto_topup") === "true";
  const shopperLimitEnabled = form.get("shopper_limit_enabled") === "true";
  const rawCount = parseInt(String(form.get("shopper_limit_count") ?? ""), 10);
  const shopperLimitCount = Math.min(500, Math.max(1, Number.isFinite(rawCount) ? rawCount : 15));
  const rawWindow = parseInt(String(form.get("shopper_limit_window_hours") ?? ""), 10);
  const shopperLimitWindowHours = SHOPPER_LIMIT_WINDOWS.includes(rawWindow) ? rawWindow : 24;

  const { data, error } = await supabaseAdmin
    .from("vto_stores")
    .update({
      overage_auto_topup: autoTopup,
      shopper_limit_enabled: shopperLimitEnabled,
      shopper_limit_count: shopperLimitCount,
      shopper_limit_window_hours: shopperLimitWindowHours,
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

// ─── Custom toggle switch ───────────────────────────────────────────────────
function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        width: 46,
        height: 28,
        borderRadius: 14,
        border: "none",
        cursor: "pointer",
        background: on ? brand.blue : brand.ink200,
        position: "relative",
        flexShrink: 0,
        transition: "background 160ms ease",
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 21 : 3,
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: brand.white,
          boxShadow: "0 1px 3px rgba(11,18,32,0.25)",
          transition: "left 160ms ease",
        }}
      />
    </button>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: "warning" | "critical" }) {
  const color = tone === "critical" ? brand.danger : tone === "warning" ? brand.warning : brand.ink;
  return (
    <div style={{ border: `1px solid ${brand.ink100}`, borderRadius: 12, background: brand.offwhite, padding: "14px 16px" }}>
      <div style={{ fontSize: 12, color: brand.ink500, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────
export default function Settings() {
  const initial = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();

  const [autoTopup, setAutoTopup] = useState<boolean>(initial.autoTopup);
  const [shopperLimitEnabled, setShopperLimitEnabled] = useState<boolean>(initial.shopperLimitEnabled);
  const [shopperLimitCount, setShopperLimitCount] = useState<string>(String(initial.shopperLimitCount));
  const [shopperLimitWindow, setShopperLimitWindow] = useState<string>(String(initial.shopperLimitWindowHours));

  const saving = fetcher.state !== "idle";
  const saved = fetcher.data?.ok === true;
  const saveError = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;
  const dirty = useMemo(
    () =>
      autoTopup !== initial.autoTopup ||
      shopperLimitEnabled !== initial.shopperLimitEnabled ||
      shopperLimitCount !== String(initial.shopperLimitCount) ||
      shopperLimitWindow !== String(initial.shopperLimitWindowHours),
    [autoTopup, shopperLimitEnabled, shopperLimitCount, shopperLimitWindow, initial],
  );

  const handleSave = () => {
    const fd = new FormData();
    fd.set("auto_topup", String(autoTopup));
    fd.set("shopper_limit_enabled", String(shopperLimitEnabled));
    fd.set("shopper_limit_count", shopperLimitCount);
    fd.set("shopper_limit_window_hours", shopperLimitWindow);
    fetcher.submit(fd, { method: "POST" });
  };

  const money = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

  // ── Usage forecast ──
  const hasPeriod = !!(initial.periodStart && initial.periodEnd);
  const included = initial.includedTryons ?? null;
  const isUnlimited = (included ?? 0) >= 9999;
  let usagePct = 0;
  let projected: number | null = null;
  let daysLeft: number | null = null;
  if (hasPeriod) {
    const start = new Date(initial.periodStart as string).getTime();
    const end = new Date(initial.periodEnd as string).getTime();
    const now = Date.now();
    const totalDays = Math.max(1, (end - start) / 86400000);
    const elapsedDays = Math.min(totalDays, Math.max(0.5, (now - start) / 86400000));
    daysLeft = Math.max(0, Math.round((end - now) / 86400000));
    projected = Math.round((initial.tryonsUsed / elapsedDays) * totalDays);
    if (included && !isUnlimited) {
      usagePct = Math.min(100, Math.round((initial.tryonsUsed / included) * 100));
    }
  }
  const usageTone: "warning" | "critical" | undefined =
    usagePct >= 90 ? "critical" : usagePct >= 70 ? "warning" : undefined;
  const willExceed = !isUnlimited && included != null && projected != null && projected > included;
  const overageCharges = Number(initial.creditsUsed) * OVERAGE_RATE;
  const periodEndFormatted = initial.periodEnd
    ? new Date(initial.periodEnd).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : null;

  return (
    <Page
      title="Settings"
      subtitle="Usage, overages, and account."
      primaryAction={{ content: "Save changes", onAction: handleSave, loading: saving, disabled: !dirty }}
    >
      <div style={{ maxWidth: 760, margin: "0 auto", width: "100%" }}>
        <BlockStack gap="500">
          {saved && !dirty && <Banner tone="success">Settings saved.</Banner>}
          {saveError && <Banner tone="critical">{saveError}</Banner>}
          {!initial.hasStore && (
            <Banner tone="warning">We couldn&apos;t find your store record yet. Finish onboarding to manage settings.</Banner>
          )}

          {/* ── Usage this period ── */}
          {hasPeriod && (
            <Card padding="500">
              <BlockStack gap="400">
                <SectionHeading
                  eyebrow="Usage"
                  title="This billing period"
                  description={
                    initial.planDisplayName
                      ? `${initial.planDisplayName} plan${periodEndFormatted ? ` · resets ${periodEndFormatted}` : ""}`
                      : undefined
                  }
                />
                {!isUnlimited && included != null && (
                  <BlockStack gap="150">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodySm" tone="subdued">
                        {initial.tryonsUsed.toLocaleString()} / {included.toLocaleString()} try-ons used
                      </Text>
                      <Text as="span" variant="bodySm" tone={usageTone === "critical" ? "critical" : "subdued"}>
                        {usagePct}%
                      </Text>
                    </InlineStack>
                    <ProgressBar
                      progress={usagePct}
                      tone={usageTone === "critical" ? "critical" : usagePct >= 70 ? "primary" : "highlight"}
                      size="small"
                    />
                  </BlockStack>
                )}
                <LineSeries data={initial.daily} height={90} />
                <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                  <MiniStat label="Used so far" value={initial.tryonsUsed.toLocaleString()} />
                  <MiniStat
                    label="Projected by period end"
                    value={projected != null ? projected.toLocaleString() : "—"}
                    tone={willExceed ? "warning" : undefined}
                  />
                  <MiniStat label="Days left" value={daysLeft != null ? String(daysLeft) : "—"} />
                </InlineGrid>
                {willExceed && (
                  <Banner tone="warning">
                    At the current pace you&apos;ll pass your included try-ons before the period resets.
                    {autoTopup
                      ? ` Extra try-ons bill at ${money(OVERAGE_RATE)} each, up to your cap.`
                      : " Try-ons will pause at the limit unless you allow overages below."}
                  </Banner>
                )}
              </BlockStack>
            </Card>
          )}

          {/* ── Overages ── */}
          <Card padding="500">
            <BlockStack gap="500">
              <SectionHeading
                eyebrow="Billing"
                title="When you hit your limit"
                description="Decide what happens once the included try-ons for the period run out."
              />

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  border: `1px solid ${brand.ink100}`,
                  borderRadius: 14,
                  background: autoTopup ? brand.blue50 : brand.white,
                  padding: "16px 18px",
                  transition: "background 160ms ease",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontWeight: 600, fontSize: 15, color: brand.ink }}>
                    {autoTopup ? "Keep try-ons running (overages on)" : "Pause try-ons at the limit"}
                  </span>
                  <span style={{ fontSize: 13, color: brand.ink500, lineHeight: 1.45 }}>
                    {autoTopup
                      ? `Try-ons continue past your monthly amount at ${money(OVERAGE_RATE)} each, up to your spend cap.`
                      : "Shoppers see the widget pause once your included try-ons are used. No surprise charges."}
                  </span>
                </div>
                <Switch on={autoTopup} onChange={setAutoTopup} />
              </div>

              <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
                <MiniStat label="Overage rate" value={`${money(OVERAGE_RATE)} / try-on`} />
                <MiniStat
                  label="Overage charges this period"
                  value={money(overageCharges)}
                  tone={overageCharges > 0 ? "warning" : undefined}
                />
                <MiniStat
                  label="Spend cap"
                  value={
                    initial.capCredits != null
                      ? `${Number(initial.capCredits).toLocaleString()} try-ons (${money(Number(initial.capCredits) * OVERAGE_RATE)})`
                      : "Not set"
                  }
                />
              </InlineGrid>

              <Text as="p" variant="bodySm" tone="subdued">
                Overage charges are billed through your Shopify subscription. Your spend cap is set during plan selection — adjust it from Billing.
              </Text>
            </BlockStack>
          </Card>

          {/* ── Per-shopper limit ── */}
          <Card padding="500">
            <BlockStack gap="500">
              <SectionHeading
                eyebrow="Protection"
                title="Per-shopper limit"
                description="Cap how many try-ons one shopper can run, so a single person can't burn through your credits."
              />

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  border: `1px solid ${brand.ink100}`,
                  borderRadius: 14,
                  background: shopperLimitEnabled ? brand.blue50 : brand.white,
                  padding: "16px 18px",
                  transition: "background 160ms ease",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontWeight: 600, fontSize: 15, color: brand.ink }}>
                    {shopperLimitEnabled ? "Shopper limit on" : "No per-shopper limit"}
                  </span>
                  <span style={{ fontSize: 13, color: brand.ink500, lineHeight: 1.45 }}>
                    {shopperLimitEnabled
                      ? "Shoppers who hit the limit see a friendly pause message until the window resets."
                      : "Every shopper can run unlimited try-ons (up to your plan's monthly amount)."}
                  </span>
                </div>
                <Switch on={shopperLimitEnabled} onChange={setShopperLimitEnabled} />
              </div>

              {shopperLimitEnabled && (
                <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
                  <TextField
                    label="Try-ons per shopper"
                    type="number"
                    min={1}
                    max={500}
                    value={shopperLimitCount}
                    onChange={setShopperLimitCount}
                    autoComplete="off"
                  />
                  <Select
                    label="Time window"
                    options={[
                      { label: "Per hour", value: "1" },
                      { label: "Per 6 hours", value: "6" },
                      { label: "Per 12 hours", value: "12" },
                      { label: "Per day", value: "24" },
                      { label: "Per week", value: "168" },
                    ]}
                    value={shopperLimitWindow}
                    onChange={setShopperLimitWindow}
                  />
                </InlineGrid>
              )}

              {shopperLimitEnabled && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Tracked per browser, with an IP backstop at 3× the limit so shared networks aren&apos;t blocked unfairly. Your own test try-ons count too — raise the limit while you&apos;re testing.
                </Text>
              )}
            </BlockStack>
          </Card>

          {/* ── Account ── */}
          {!initial.skipBilling && (
            <Card padding="500">
              <InlineStack align="space-between" blockAlign="center">
                <SectionHeading eyebrow="Account" title="Plan" description="Change your plan, included try-ons, and spend cap." />
                <Button onClick={() => navigate("/app/billing")}>Manage billing</Button>
              </InlineStack>
            </Card>
          )}
        </BlockStack>
      </div>
    </Page>
  );
}
