import { useEffect, useRef, useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { Page, Banner } from "@shopify/polaris";
import { motion } from "motion/react";
import NumberFlow from "@number-flow/react";
import { Shirt, Tag, Coins, Clock, Check } from "lucide-react";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { syncShopifyMerchantToSupabase } from "../lib/shopify-billing.server";
import {
  AOV_DEFAULT,
  OVERAGE_USD_PER_TRYON,
  PRICING_PLANS,
  breakEvenOrders,
  formatMoney,
} from "../lib/pricing-plans";

const TRIAL_DAYS = 7;

// ─── Ello brand palette (source: vault 02-Areas/Ello/_context/Brand-Palette.md) ─
const C = {
  blue: "#3B63D4",
  blue700: "#2544A3",
  blue600: "#2E51BD",
  blue500: "#4E77E4",
  blue400: "#7A99F0",
  blue100: "#E8EEFD",
  blue50: "#F4F7FE",
  ink: "#0B1220",
  ink700: "#2A3347",
  ink500: "#6B7388",
  border: "#D8DCE3",
  offwhite: "#FAFBFC",
  white: "#FFFFFF",
};

// ─── Onboarding recap (shown beside the AOV calculator during onboarding) ────

const DEFAULT_BRAND_COLOR = "#111827";

function normalizeHex(input: string | null | undefined): string {
  const trimmed = input?.trim() ?? "";
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  return DEFAULT_BRAND_COLOR;
}

function readableTextColor(hex: string): "#000000" | "#FFFFFF" {
  const normalized = normalizeHex(hex).replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#000000" : "#FFFFFF";
}

type OnboardingRecap = {
  brandColor: string;
  position: "left" | "right";
  inlineEnabled: boolean;
  floatingNonPdpEnabled: boolean;
  previewEnabled: boolean;
  floatingPdpEnabled: boolean;
  widgetLive: boolean;
};

// ─── Billing config lookup (mirrors shopify.server.ts) ───────────────────────

type BillingLineItem = {
  amount: number;
  currencyCode: string;
  interval: "EVERY_30_DAYS" | "ANNUAL";
  terms?: string;
};

function getBillingPlan(planKey: string, isTest: boolean): { lineItems: BillingLineItem[]; test: boolean } | null {
  const configs = Object.fromEntries(
    PRICING_PLANS.flatMap((plan) => [
      [`${plan.key}_monthly`, { amount: plan.monthlyPrice, interval: "EVERY_30_DAYS" as const }],
      [`${plan.key}_annual`, { amount: plan.annualPrice, interval: "ANNUAL" as const }],
    ]),
  );
  const cfg = configs[planKey];
  if (!cfg) return null;
  return {
    test: isTest,
    lineItems: [
      { amount: cfg.amount, currencyCode: "USD", interval: cfg.interval },
      { amount: 15, currencyCode: "USD", interval: "EVERY_30_DAYS", terms: `$${OVERAGE_USD_PER_TRYON.toFixed(2)} per try-on beyond your plan's included amount` },
    ],
  };
}

// ─── Loader ──────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const billingError = url.searchParams.get("billingError") ?? null;

  // During onboarding (placements → billing), surface a recap of what the
  // merchant just set up so the trial reads as "turn on what I built" rather
  // than a cold paywall. Skipped for existing merchants changing plans.
  let recap: OnboardingRecap | null = null;
  if (url.searchParams.get("onboarding") === "1") {
    const { data } = await supabaseAdmin
      .from("vto_stores")
      .select(
        "inline_button_color, minimized_color, widget_primary_color, widget_position, inline_button_enabled, floating_widget_non_pdp_enabled, desktop_preview_enabled, floating_widget_pdp_enabled, widget_enabled_at",
      )
      .eq("shop_domain", session.shop)
      .maybeSingle();

    if (data) {
      recap = {
        brandColor: normalizeHex(
          data.inline_button_color ?? data.minimized_color ?? data.widget_primary_color,
        ),
        position: data.widget_position === "left" ? "left" : "right",
        inlineEnabled: data.inline_button_enabled ?? true,
        floatingNonPdpEnabled: data.floating_widget_non_pdp_enabled ?? true,
        previewEnabled: data.desktop_preview_enabled ?? true,
        floatingPdpEnabled: data.floating_widget_pdp_enabled ?? false,
        widgetLive: Boolean(data.widget_enabled_at),
      };
    }
  }

  return { billingError, recap };
}

// ─── Action: create subscription via GraphQL, return confirmationUrl ─────────

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const planKey = formData.get("planKey") as string;
  const interval = formData.get("interval") as string;

  // ello_free: no Shopify billing — just sync and return a redirect signal
  // for the client to navigate. (fetcher.submit does not auto-follow redirects.)
  if (planKey === "ello_free") {
    try {
      const shopQuery = await admin.graphql(`query { shop { email } }`);
      const shopJson = await shopQuery.json();
      const shopEmail = shopJson?.data?.shop?.email ?? session.shop;
      await syncShopifyMerchantToSupabase(session.shop, shopEmail, "ello_free", undefined);
    } catch (err) {
      console.error(`[Billing] ello_free sync failed for ${session.shop}:`, err);
      return { error: "Failed to activate free plan. Please try again." };
    }
    return { redirectTo: "/app" };
  }

  const fullPlanKey = `${planKey}_${interval}`;

  // Determine test mode
  let isDevStore = false;
  try {
    const shopResp = await admin.graphql(`query { shop { plan { partnerDevelopment } } }`);
    const shopJson = await shopResp.json();
    isDevStore = shopJson?.data?.shop?.plan?.partnerDevelopment === true;
  } catch { /* ignore */ }
  // eslint-disable-next-line no-undef
  const isTest = process.env.BILLING_TEST_MODE === "true" || process.env.SKIP_BILLING === "true" || isDevStore;

  const billingPlan = getBillingPlan(fullPlanKey, isTest);
  if (!billingPlan) {
    return { error: `Unknown plan: ${fullPlanKey}` };
  }

  // Return directly to the Shopify admin embedded app URL.
  // This avoids the top-level bounce through the Cloud Run URL that causes
  // a brief login page. The billing gate in app.tsx handles syncing the
  // subscription to Supabase on the next page load.
  const storeHandle = session.shop.replace(".myshopify.com", "");
  const returnUrl = `https://admin.shopify.com/store/${storeHandle}/apps/${process.env.SHOPIFY_API_KEY}/app`;

  // Build the GraphQL mutation
  const recurringItem = billingPlan.lineItems[0];
  const usageItem = billingPlan.lineItems[1];

  const mutation = `#graphql
    mutation AppSubscriptionCreate(
      $name: String!,
      $returnUrl: URL!,
      $test: Boolean,
      $trialDays: Int,
      $lineItems: [AppSubscriptionLineItemInput!]!,
      $replacementBehavior: AppSubscriptionReplacementBehavior
    ) {
      appSubscriptionCreate(
        name: $name,
        returnUrl: $returnUrl,
        test: $test,
        trialDays: $trialDays,
        lineItems: $lineItems,
        replacementBehavior: $replacementBehavior
      ) {
        appSubscription { id }
        confirmationUrl
        userErrors { field message }
      }
    }
  `;

  const variables = {
    name: fullPlanKey,
    returnUrl: returnUrl.toString(),
    test: isTest,
    trialDays: TRIAL_DAYS,
    replacementBehavior: "APPLY_IMMEDIATELY",
    lineItems: [
      {
        plan: {
          appRecurringPricingDetails: {
            price: { amount: recurringItem.amount, currencyCode: "USD" },
            interval: recurringItem.interval,
          },
        },
      },
      {
        plan: {
          appUsagePricingDetails: {
            cappedAmount: { amount: usageItem.amount, currencyCode: "USD" },
            terms: usageItem.terms,
          },
        },
      },
    ],
  };

  try {
    console.log(`[Billing] Creating subscription ${fullPlanKey} for ${session.shop} (test: ${isTest})`);
    const resp = await admin.graphql(mutation, { variables });
    const json = await resp.json();

    const result = json?.data?.appSubscriptionCreate;
    if (result?.userErrors?.length > 0) {
      const errMsg = result.userErrors.map((e: { message: string }) => e.message).join(", ");
      console.error(`[Billing] userErrors for ${session.shop}:`, errMsg);
      return { error: errMsg };
    }

    const confirmationUrl = result?.confirmationUrl;
    if (!confirmationUrl) {
      console.error("[Billing] No confirmationUrl returned");
      return { error: "Failed to create subscription — no confirmation URL" };
    }

    console.log(`[Billing] Subscription created for ${session.shop}, redirecting to: ${confirmationUrl}`);
    return { confirmationUrl };
  } catch (err) {
    console.error("[Billing] GraphQL error:", err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Reveal animation (recreates the demo's TimelineContent blur-in) ─────────

const reveal = {
  hidden: { opacity: 0, y: -20, filter: "blur(10px)" },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { delay: i * 0.12, duration: 0.5 },
  }),
};

// ─── Interval toggle (motion sliding pill, Ello blue) ────────────────────────

function PricingSwitch({
  interval,
  onSwitch,
}: {
  interval: "monthly" | "annual";
  onSwitch: (v: "monthly" | "annual") => void;
}) {
  const indicator = (
    <motion.span
      layoutId="billing-switch"
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 999,
        background: `linear-gradient(to top, ${C.blue600}, ${C.blue500} 70%, ${C.blue400})`,
        border: `3px solid ${C.blue600}`,
        boxShadow: `0 4px 14px rgba(59, 99, 212, 0.45)`,
      }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
    />
  );

  const btn = (active: boolean): React.CSSProperties => ({
    position: "relative",
    zIndex: 10,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    padding: "10px 24px",
    borderRadius: 999,
    fontSize: 15,
    fontWeight: 600,
    color: active ? C.white : C.ink500,
    transition: "color 0.2s",
  });

  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <div
        style={{
          position: "relative",
          display: "inline-flex",
          padding: 4,
          borderRadius: 999,
          background: C.white,
          border: `1px solid ${C.border}`,
          boxShadow: "0 1px 2px rgba(11,18,32,0.05)",
        }}
      >
        <button type="button" onClick={() => onSwitch("monthly")} style={btn(interval === "monthly")}>
          {interval === "monthly" && indicator}
          <span style={{ position: "relative", zIndex: 1 }}>Monthly</span>
        </button>
        <button type="button" onClick={() => onSwitch("annual")} style={btn(interval === "annual")}>
          {interval === "annual" && indicator}
          <span style={{ position: "relative", zIndex: 1, display: "inline-flex", alignItems: "center", gap: 8 }}>
            Annual
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: 999,
                background: interval === "annual" ? "rgba(255,255,255,0.22)" : C.blue50,
                color: interval === "annual" ? C.white : C.blue,
              }}
            >
              Save 10%
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

// ─── Onboarding recap card ───────────────────────────────────────────────────

function OnboardingRecapCard({ recap }: { recap: OnboardingRecap }) {
  const placements = [
    { label: "Inline Try-On button", on: recap.inlineEnabled },
    { label: "Floating widget", on: recap.floatingNonPdpEnabled },
    { label: "Desktop preview prompt", on: recap.previewEnabled },
    { label: "Floating on product pages", on: recap.floatingPdpEnabled },
  ].filter((p) => p.on);

  const buttonTextColor = readableTextColor(recap.brandColor);

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        height: "100%",
        padding: "18px 22px",
        background: C.white,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        boxShadow: "0 1px 2px rgba(11,18,32,0.05)",
        overflow: "hidden",
      }}
    >
      {/* Brand-color accent — makes the card feel like theirs */}
      <div
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: recap.brandColor }}
      />

      <InlineStackBetween>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.07em",
            textTransform: "uppercase",
            color: C.ink500,
          }}
        >
          Your custom setup
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            padding: "2px 9px",
            borderRadius: 999,
            whiteSpace: "nowrap",
            background: recap.widgetLive ? "#E7F6EE" : C.blue50,
            color: recap.widgetLive ? "#17713F" : C.blue,
          }}
        >
          {recap.widgetLive ? "Live on your store" : "Ready to activate"}
        </span>
      </InlineStackBetween>

      {/* Live preview of THEIR button in THEIR color + position */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "8px 16px",
            borderRadius: 10,
            background: recap.brandColor,
            color: buttonTextColor,
            fontSize: 13,
            fontWeight: 700,
            boxShadow: "0 2px 8px rgba(11,18,32,0.16)",
          }}
        >
          <Shirt size={15} /> Try On
        </span>
        <span style={{ fontSize: 12.5, color: C.ink500 }}>
          {recap.brandColor.toUpperCase()} · {recap.position === "left" ? "Bottom-left" : "Bottom-right"}
        </span>
      </div>

      {/* What's switched on */}
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {placements.map((p) => (
          <span
            key={p.label}
            style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: C.ink700 }}
          >
            <Check size={14} strokeWidth={3} color={C.blue} />
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function InlineStackBetween({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      {children}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const { billingError, recap } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const pricingRef = useRef<HTMLDivElement>(null);
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [averageOrderValue, setAverageOrderValue] = useState(AOV_DEFAULT);

  // When the action returns a confirmationUrl, redirect the TOP frame to it.
  // This is the correct way to handle billing redirects in embedded Shopify apps —
  // the Shopify billing page must load at the top level, not in the iframe.
  const actionData = fetcher.data as { confirmationUrl?: string; error?: string; redirectTo?: string } | undefined;
  useEffect(() => {
    if (!actionData?.confirmationUrl) return;
    window.open(actionData.confirmationUrl, "_top");
  }, [actionData?.confirmationUrl]);

  // ello_free flow: no Shopify billing — navigate to dashboard in-app.
  useEffect(() => {
    if (!actionData?.redirectTo) return;
    navigate(actionData.redirectTo);
  }, [actionData?.redirectTo, navigate]);

  const actionError = actionData?.error;
  const isSubmitting = fetcher.state === "submitting" || fetcher.state === "loading";
  const billingIntervalLabel = interval === "monthly" ? "monthly" : "annually";

  const handleSelectPlan = (planKey: string) => {
    setSelectedPlan(planKey);
    fetcher.submit({ planKey, interval }, { method: "POST" });
  };

  return (
    <Page fullWidth>
      <div
        ref={pricingRef}
        style={{
          position: "relative",
          overflow: "hidden",
          borderRadius: 16,
          background: C.offwhite,
          padding: "16px 16px 56px",
        }}
      >
        {/* Soft blue radial glow — kept subtle per brand rule (white-first, blue accent) */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: "10%",
            width: "80%",
            height: "70%",
            zIndex: 0,
            backgroundImage: `radial-gradient(circle at 50% 0%, ${C.blue400} 0%, transparent 60%)`,
            opacity: 0.16,
            pointerEvents: "none",
          }}
        />

        <div style={{ position: "relative", zIndex: 1 }}>
          {/* Error banner */}
          {(billingError || actionError) && (
            <div style={{ maxWidth: 1280, margin: "0 auto 20px" }}>
              <Banner title="Billing Error" tone="critical">
                {actionError || billingError}
              </Banner>
            </div>
          )}

          {/* Heading */}
          <motion.div
            custom={0}
            initial="hidden"
            animate="visible"
            variants={reveal}
            style={{ textAlign: "center", maxWidth: 720, margin: "8px auto 0" }}
          >
            <h2
              style={{
                fontFamily: "Georgia, 'Times New Roman', serif",
                fontSize: "clamp(32px, 5vw, 56px)",
                fontWeight: 500,
                color: C.ink,
                margin: "0 0 14px",
                lineHeight: 1.05,
                letterSpacing: "-0.01em",
              }}
            >
              Pricing that{" "}
              <span style={{ color: C.blue, fontStyle: "italic" }}>pays for itself</span>
            </h2>
            <p style={{ fontSize: 16, color: C.ink500, maxWidth: 560, margin: "0 auto", lineHeight: 1.5 }}>
              Every Ello plan is sized so a few extra sales from try-on cover the whole month. Set your
              average order value and see exactly where you break even.
            </p>
          </motion.div>

          {/* Interval toggle */}
          <motion.div custom={1} initial="hidden" animate="visible" variants={reveal} style={{ marginTop: 28 }}>
            <PricingSwitch interval={interval} onSwitch={setInterval} />
          </motion.div>

          {/* Your-setup recap (onboarding only) + AOV calculator, same row */}
          <motion.div custom={2} initial="hidden" animate="visible" variants={reveal}>
            <div
              style={{
                maxWidth: recap ? 940 : 640,
                margin: "24px auto 0",
                display: "grid",
                gridTemplateColumns: recap ? "repeat(auto-fit, minmax(290px, 1fr))" : "1fr",
                gap: 16,
                alignItems: "stretch",
              }}
            >
              {recap && <OnboardingRecapCard recap={recap} />}

              <div
                style={{
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                  height: "100%",
                  padding: "18px 22px",
                  background: C.white,
                  border: `1px solid ${C.border}`,
                  borderRadius: 14,
                  boxShadow: "0 1px 2px rgba(11,18,32,0.05)",
                  overflow: "hidden",
                }}
              >
                {/* Ello-blue accent — pairs with the brand-color setup card */}
                <div
                  style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: C.blue }}
                />

                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.07em",
                    textTransform: "uppercase",
                    color: C.ink500,
                  }}
                >
                  Your average order value
                </span>

                <div style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                  <span style={{ fontSize: 30, fontWeight: 800, color: C.ink }}>$</span>
                  <input
                    id="average-order-value"
                    type="number"
                    min="1"
                    step="1"
                    value={averageOrderValue}
                    onChange={(e) => setAverageOrderValue(Number(e.currentTarget.value))}
                    style={{
                      width: 110,
                      fontSize: 30,
                      fontWeight: 800,
                      color: C.ink,
                      padding: "4px 12px",
                      border: `1px solid ${C.border}`,
                      borderRadius: 10,
                      outline: "none",
                    }}
                  />
                </div>

                <span style={{ fontSize: 13.5, color: C.ink500, lineHeight: 1.5, maxWidth: 320 }}>
                  Change this to see exactly how many sales each plan needs to pay for itself.
                </span>
              </div>
            </div>
          </motion.div>

          {/* Plan grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
              gap: 20,
              maxWidth: 1280,
              margin: "36px auto 0",
              alignItems: "stretch",
            }}
          >
            {PRICING_PLANS.map((plan, index) => {
              const popular = !!plan.featured;
              const effectiveMonthly = interval === "monthly" ? plan.monthlyPrice : plan.annualPrice / 12;
              const breakEven = breakEvenOrders(effectiveMonthly, averageOrderValue);
              const features = [
                { icon: <Shirt size={18} />, text: `${plan.includedTryons.toLocaleString()} try-ons every month` },
                { icon: <Tag size={18} />, text: "No Ello branding on the widget" },
                { icon: <Coins size={18} />, text: `$${OVERAGE_USD_PER_TRYON.toFixed(2)} per try-on after that` },
                { icon: <Clock size={18} />, text: "7-day free trial · cancel anytime" },
              ];

              return (
                <motion.div key={plan.key} custom={3 + index} initial="hidden" animate="visible" variants={reveal} style={{ height: "100%" }}>
                  <div
                    style={{
                      position: "relative",
                      height: "100%",
                      display: "flex",
                      flexDirection: "column",
                      gap: 18,
                      borderRadius: 16,
                      padding: 26,
                      background: popular ? C.blue50 : C.white,
                      border: popular ? `2px solid ${C.blue}` : `1px solid ${C.border}`,
                      boxShadow: popular
                        ? "0 18px 40px rgba(59, 99, 212, 0.18)"
                        : "0 1px 2px rgba(11,18,32,0.06)",
                    }}
                  >
                    {/* Name + popular badge */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div style={{ fontSize: 24, fontWeight: 700, color: C.ink }}>Ello {plan.displayName}</div>
                      {popular && (
                        <span
                          style={{
                            background: `linear-gradient(to top, ${C.blue600}, ${C.blue500})`,
                            color: C.white,
                            fontSize: 12,
                            fontWeight: 700,
                            padding: "4px 12px",
                            borderRadius: 999,
                            whiteSpace: "nowrap",
                          }}
                        >
                          Best first plan
                        </span>
                      )}
                    </div>

                    {/* Price */}
                    <div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        {interval === "annual" && (
                          <span style={{ fontSize: 20, fontWeight: 600, color: C.ink500, textDecoration: "line-through" }}>
                            {formatMoney(plan.monthlyPrice)}
                          </span>
                        )}
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "baseline",
                            fontSize: 40,
                            fontWeight: 800,
                            color: C.ink,
                            lineHeight: 1,
                            letterSpacing: "-0.02em",
                          }}
                        >
                          $
                          <NumberFlow
                            value={effectiveMonthly}
                            format={{
                              minimumFractionDigits: interval === "annual" ? 2 : 0,
                              maximumFractionDigits: 2,
                            }}
                          />
                        </span>
                        <span style={{ fontSize: 15, fontWeight: 500, color: C.ink500 }}>/mo</span>
                      </div>
                      <div style={{ fontSize: 13, color: C.ink500, marginTop: 6, minHeight: 18 }}>{plan.positioning}</div>
                      {interval === "annual" && (
                        <div style={{ fontSize: 12, fontWeight: 600, color: C.blue, marginTop: 4 }}>
                          Billed annually at {formatMoney(plan.annualPrice)}/yr · save 10%
                        </div>
                      )}
                    </div>

                    {/* Break-even callout (the AOV mechanic) */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        padding: "14px 16px",
                        background: popular ? C.white : C.blue50,
                        border: `1px solid ${C.blue100}`,
                        borderRadius: 12,
                      }}
                    >
                      <span style={{ fontSize: 40, fontWeight: 800, lineHeight: 1, color: C.blue, fontVariantNumeric: "tabular-nums" }}>
                        {breakEven ?? "—"}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: C.ink700, lineHeight: 1.35 }}>
                        {breakEven === 1 ? "sale from try-on" : "sales from try-on"} pays for the month
                      </span>
                    </div>

                    {/* CTA */}
                    <button
                      type="button"
                      onClick={() => handleSelectPlan(plan.key)}
                      disabled={isSubmitting}
                      style={{
                        width: "100%",
                        padding: 14,
                        fontSize: 16,
                        fontWeight: 600,
                        borderRadius: 12,
                        border: "none",
                        color: C.white,
                        cursor: isSubmitting ? "default" : "pointer",
                        background: popular
                          ? `linear-gradient(to top, ${C.blue600}, ${C.blue500})`
                          : `linear-gradient(to top, ${C.ink}, ${C.ink700})`,
                        boxShadow: popular
                          ? "0 8px 20px rgba(59, 99, 212, 0.35)"
                          : "0 8px 20px rgba(11,18,32,0.18)",
                        opacity: isSubmitting && selectedPlan !== plan.key ? 0.55 : 1,
                        transition: "opacity 0.2s",
                      }}
                    >
                      {isSubmitting && selectedPlan === plan.key ? "Starting…" : "Start 7-day trial"}
                    </button>

                    {/* Feature list */}
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
                      {features.map((f) => (
                        <li key={f.text} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <span style={{ color: C.ink700, display: "grid", placeContent: "center", flexShrink: 0 }}>{f.icon}</span>
                          <span style={{ fontSize: 14, color: C.ink700 }}>{f.text}</span>
                        </li>
                      ))}
                    </ul>

                    <div style={{ marginTop: "auto", paddingTop: 8, fontSize: 12, color: C.ink500 }}>
                      Billed {billingIntervalLabel}. Usage resets monthly.
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>

          {/* Free + Enterprise — secondary options */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: 20,
              maxWidth: 1280,
              margin: "20px auto 0",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 14,
                padding: 24,
                background: C.white,
                border: `1px solid ${C.border}`,
                borderRadius: 14,
                boxShadow: "0 1px 2px rgba(11,18,32,0.05)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 18, fontWeight: 700, color: C.ink }}>Ello Free</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.blue, background: C.blue50, padding: "2px 10px", borderRadius: 999 }}>Free</span>
              </div>
              <div style={{ flex: 1, fontSize: 14, color: C.ink500, lineHeight: 1.5 }}>
                $0/month · 10 try-ons per month · Ello branding on widget. No overages — upgrade anytime when
                you are ready for real traffic.
              </div>
              <button
                type="button"
                onClick={() => handleSelectPlan("ello_free")}
                disabled={isSubmitting}
                style={{
                  padding: "12px 16px",
                  fontSize: 15,
                  fontWeight: 600,
                  borderRadius: 10,
                  border: `1px solid ${C.border}`,
                  background: C.white,
                  color: C.ink,
                  cursor: isSubmitting ? "default" : "pointer",
                  opacity: isSubmitting && selectedPlan !== "ello_free" ? 0.55 : 1,
                }}
              >
                {isSubmitting && selectedPlan === "ello_free" ? "Starting…" : "Use Free Plan"}
              </button>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 14,
                padding: 24,
                background: C.white,
                border: `1px solid ${C.border}`,
                borderRadius: 14,
                boxShadow: "0 1px 2px rgba(11,18,32,0.05)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 18, fontWeight: 700, color: C.ink }}>Enterprise</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.blue, background: C.blue50, padding: "2px 10px", borderRadius: 999 }}>Custom</span>
              </div>
              <div style={{ flex: 1, fontSize: 14, color: C.ink500, lineHeight: 1.5 }}>
                Custom try-on volume, pricing, and rollout support. For brands that need higher included usage,
                procurement support, or manual account setup.
              </div>
              <a
                href="https://calendly.com/andrew-ello/ello-setup-call"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  textAlign: "center",
                  padding: "12px 16px",
                  fontSize: 15,
                  fontWeight: 600,
                  borderRadius: 10,
                  border: `1px solid ${C.border}`,
                  background: C.white,
                  color: C.ink,
                  textDecoration: "none",
                }}
              >
                Book a setup call
              </a>
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
