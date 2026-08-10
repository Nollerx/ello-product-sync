// Billing statement: the itemized proof behind a rev-share invoice.
//
// The promise on sales calls is that a client can audit their bill line by line
// back to real Shopify orders. This page is that promise, self-serve: pick a
// month, see every sale being counted, export the same rows as CSV to sit
// alongside the Stripe invoice.
//
// Deliberately separate from /app/proof. Proof answers "does the widget cause
// more sales" (holdout, lift, confidence). This answers "why is this number on
// my bill" — different question, different rounding rules, different audience
// (a finance person reconciling, not a marketer evaluating).
//
// The rate comes from vto_billing_deals, never from a constant here or a query
// param: rates are negotiated per client (4Winners closed at 10%, the term-sheet
// default is 15%, Option B clients pay a flat monthly fee), and a hardcoded
// default would confidently show the wrong number to whoever is not on it. A
// store with no deal on file shows its sales and says nothing is being charged,
// rather than inventing a fee.

import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Banner,
  Button,
  DataTable,
  Select,
} from "@shopify/polaris";
import { CashDollarIcon, ReturnIcon, OrderIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { SectionHeading } from "../components/ui";
import { KpiTile } from "../components/analytics";
import {
  getStoreContext,
  getShopTimezone,
  getBillingStatement,
  getInvoice,
} from "../lib/analytics.server";
import { resolveBillingPeriod, recentMonthKeys } from "../lib/billing-period";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const store = await getStoreContext(session.shop);
  const url = new URL(request.url);

  if (!store.slug) {
    return {
      ready: false as const,
      lines: [],
      invoice: null,
      period: { key: "", label: "" },
      months: [],
      timeZone: "UTC",
    };
  }

  const timeZone = await getShopTimezone(admin, session.shop);
  const period = resolveBillingPeriod(url.searchParams.get("month"), timeZone);
  const [lines, invoice] = await Promise.all([
    getBillingStatement(store.slug, period.from, period.to),
    getInvoice(store.slug, period.from, period.to),
  ]);

  return {
    ready: true as const,
    lines,
    invoice,
    period: { key: period.key, label: period.label },
    months: recentMonthKeys(timeZone, 12),
    timeZone,
  };
};

function money(value: number | null, currency: string | null): string {
  if (value == null) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

function stamp(iso: string, timeZone: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

export default function StatementPage() {
  const { ready, lines, invoice, period, months, timeZone } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const currency = invoice?.currency ?? null;
  const hasDeal = invoice?.hasDeal === true;

  const downloadCsv = async () => {
    try {
      const qs = new URLSearchParams({ month: period.key });
      const res = await fetch(`/app/statement/export?${qs.toString()}`);
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ello-statement-${period.key}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[statement] export failed:", err);
    }
  };

  const rows = lines.map((l) => [
    l.orderId ?? "—",
    l.productName ?? (l.productId ? `Product ${l.productId}` : "—"),
    stamp(l.triedOnAt, timeZone),
    stamp(l.purchasedAt, timeZone),
    l.refundedAmount > 0 ? `−${money(l.refundedAmount, l.currency)}` : "—",
    // During the free window a sale is shown in full but billed on nothing —
    // saying "Free" is clearer to a client than a $0.00 they might read as a
    // tracking failure.
    l.inTrial ? "Free" : money(l.billableNet, l.currency),
  ]);

  const termsLabel = !invoice
    ? null
    : invoice.dealType === "rev_share" && invoice.revSharePercent != null
      ? `${invoice.revSharePercent}% of attributed revenue`
      : invoice.dealType === "flat" && invoice.flatAmount != null
        ? `${money(invoice.flatAmount, currency)} per month${
            invoice.includedTryons ? `, ${invoice.includedTryons} try-ons included` : ""
          }`
        : null;

  return (
    <Page
      title="Billing statement"
      subtitle="Every sale counted toward your bill, with the Shopify order id behind it."
    >
      <BlockStack gap="500">
        <Card padding="500">
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center" gap="300">
              <Select
                label="Billing period"
                labelInline
                options={months.map((m) => ({ label: m.label, value: m.key }))}
                value={period.key}
                onChange={(value) => {
                  const next = new URLSearchParams(searchParams);
                  next.set("month", value);
                  setSearchParams(next);
                }}
              />
              <Button onClick={downloadCsv} disabled={!lines.length}>
                Export CSV
              </Button>
            </InlineStack>

            {ready && !hasDeal ? (
              <Banner tone="info">
                <Text as="p">
                  No billing terms are on file for your store, so nothing is being charged for this period.
                  Every sale below is still tracked in full.
                </Text>
              </Banner>
            ) : null}

            {hasDeal && termsLabel ? (
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="info">{termsLabel}</Badge>
                {invoice?.trialUntil ? (
                  <Badge tone="success">
                    {`Free until ${new Intl.DateTimeFormat("en-US", {
                      timeZone,
                      month: "short",
                      day: "numeric",
                    }).format(new Date(invoice.trialUntil))}`}
                  </Badge>
                ) : null}
              </InlineStack>
            ) : null}

            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
              <KpiTile
                label="Attributed revenue"
                value={money(invoice?.grossAttributed ?? 0, currency)}
                hint={`${invoice?.salesCount ?? lines.length} sales across ${invoice?.ordersCount ?? 0} orders`}
                icon={CashDollarIcon}
              />
              <KpiTile
                label={invoice && invoice.trialExcluded > 0 ? "Returns and free trial" : "Returned"}
                value={
                  invoice && (invoice.refunded > 0 || invoice.trialExcluded > 0)
                    ? `−${money(invoice.refunded + invoice.trialExcluded, currency)}`
                    : money(0, currency)
                }
                hint={
                  invoice && invoice.trialExcluded > 0
                    ? "refunds within 45 days, plus free-trial sales"
                    : "refunds within 45 days, taken back off"
                }
                icon={ReturnIcon}
              />
              <KpiTile
                label={
                  hasDeal && invoice?.dealType === "rev_share"
                    ? `Your fee at ${invoice.revSharePercent}%`
                    : hasDeal
                      ? "Your fee"
                      : "Billed on"
                }
                value={
                  hasDeal
                    ? money(invoice?.amountDue ?? null, currency)
                    : money(invoice?.billableNet ?? 0, currency)
                }
                hint={
                  hasDeal && invoice?.dealType === "rev_share"
                    ? `${invoice.revSharePercent}% of ${money(invoice.billableNet, currency)}`
                    : hasDeal
                      ? "flat monthly fee"
                      : "attributed revenue, net of returns"
                }
                icon={OrderIcon}
                accent
              />
            </InlineGrid>
          </BlockStack>
        </Card>

        <Card padding="500">
          <BlockStack gap="400">
            <SectionHeading
              title={`Every sale counted in ${period.label}`}
              description="A shopper tried this product on, then bought that same product. Look up any order id in your Shopify admin to check it."
            />
            {rows.length ? (
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "numeric", "numeric"]}
                headings={["Shopify order", "Product tried on", "Tried on", "Purchased", "Returned", "Billed on"]}
                rows={rows}
                totals={["", "", "", "", "", money(invoice?.billableNet ?? 0, currency)]}
                showTotalsInFooter
              />
            ) : (
              <Text as="p" tone="subdued">
                {ready
                  ? `No attributed sales in ${period.label}. Nothing to bill for this period.`
                  : "Statement will appear once your store finishes connecting."}
              </Text>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              How a sale qualifies: the shopper ran a successful try-on, then bought that same product within
              7 days, in the same browser session. Only the tried-on line counts — never shipping, never tax,
              never the rest of the cart — at the discounted price actually paid. Refunds within 45 days come
              back off automatically. Times shown in your store&apos;s timezone ({timeZone}).
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
