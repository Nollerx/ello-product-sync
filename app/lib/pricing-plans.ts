export type PricingPlan = {
  key: "starter" | "launch" | "growth" | "scale";
  displayName: string;
  monthlyPrice: number;
  annualPrice: number;
  includedTryons: number;
  positioning: string;
  featured?: boolean;
};

export const AOV_DEFAULT = 65;
export const OVERAGE_USD_PER_TRYON = 0.15;

export const PRICING_PLANS: PricingPlan[] = [
  {
    key: "starter",
    displayName: "Starter",
    monthlyPrice: 49,
    annualPrice: 529.2,
    includedTryons: 75,
    positioning: "Low-risk entry",
  },
  {
    key: "launch",
    displayName: "Launch",
    monthlyPrice: 97,
    annualPrice: 1047.6,
    includedTryons: 300,
    positioning: "Real first paid plan",
    featured: true,
  },
  {
    key: "growth",
    displayName: "Growth",
    monthlyPrice: 249,
    annualPrice: 2689.2,
    includedTryons: 1500,
    positioning: "Serious store",
  },
  {
    key: "scale",
    displayName: "Scale",
    monthlyPrice: 649,
    annualPrice: 7009.2,
    includedTryons: 5000,
    positioning: "High-volume brand",
  },
];

export function paidPlanKey(planKey: PricingPlan["key"], interval: "monthly" | "annual") {
  return `${planKey}_${interval}`;
}

export function formatMoney(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
}

export function breakEvenOrders(monthlyPrice: number, averageOrderValue: number) {
  if (!Number.isFinite(averageOrderValue) || averageOrderValue <= 0) return null;
  return Math.ceil(monthlyPrice / averageOrderValue);
}
