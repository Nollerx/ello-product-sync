import { supabaseAdmin } from "./supabase.server";

export type OnboardingStep =
  | "welcome"
  | "activate_widget"
  | "configure"
  | "placements"
  | "billing"
  | "complete";

export const ONBOARDING_ROUTE_BY_STEP: Record<Exclude<OnboardingStep, "billing" | "complete">, string> = {
  welcome: "/app/onboarding/welcome",
  configure: "/app/onboarding/configure",
  activate_widget: "/app/onboarding/activate-widget",
  placements: "/app/onboarding/placements",
};

const INLINE_TRYON_BLOCK_HANDLE = "inline-tryon-button";
const FALLBACK_THEME_APP_API_KEY = "3ab87c3a17258dd8b44f288b81b7dfc7";

// Order: welcome → configure → placements/install → billing → complete.
// The legacy activate_widget step still has a route so merchants already there
// can proceed, but new onboarding uses the unified placements page.
const STEP_ORDER: OnboardingStep[] = ["welcome", "configure", "placements", "billing", "complete"];

export function nextStep(current: OnboardingStep): OnboardingStep {
  const idx = STEP_ORDER.indexOf(current);
  if (idx < 0 || idx >= STEP_ORDER.length - 1) return "complete";
  return STEP_ORDER[idx + 1];
}

export async function getOnboardingState(shopDomain: string): Promise<{
  step: OnboardingStep;
  widgetEnabledAt: string | null;
}> {
  const { data, error } = await supabaseAdmin
    .from("vto_stores")
    .select("onboarding_step, widget_enabled_at")
    .eq("shop_domain", shopDomain)
    .maybeSingle();

  if (error) {
    console.error("[Onboarding] getOnboardingState error:", error.message);
  }

  return {
    step: (data?.onboarding_step as OnboardingStep | undefined) ?? "complete",
    widgetEnabledAt: data?.widget_enabled_at ?? null,
  };
}

export async function setOnboardingStep(shopDomain: string, step: OnboardingStep): Promise<void> {
  const patch: Record<string, unknown> = { onboarding_step: step };
  if (step === "welcome") patch.onboarding_started_at = new Date().toISOString();
  if (step === "complete") patch.onboarding_completed_at = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from("vto_stores")
    .update(patch)
    .eq("shop_domain", shopDomain);

  if (error) {
    console.error(`[Onboarding] setOnboardingStep(${step}) error:`, error.message);
  }
}

export async function markWidgetEnabled(shopDomainOrSlug: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("vto_stores")
    .update({ widget_enabled_at: new Date().toISOString() })
    .or(`shop_domain.eq.${shopDomainOrSlug},store_slug.eq.${shopDomainOrSlug}`)
    .is("widget_enabled_at", null);

  if (error) {
    console.error("[Onboarding] markWidgetEnabled error:", error.message);
  }
}

export function preserveShopifyQuery(sourceUrl: URL): string {
  const params = new URLSearchParams();
  for (const key of ["shop", "host", "embedded", "id_token"]) {
    const val = sourceUrl.searchParams.get(key);
    if (val) params.set(key, val);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function onboardingRouteForStep(step: OnboardingStep): string | null {
  if (step === "billing" || step === "complete") return null;
  return ONBOARDING_ROUTE_BY_STEP[step];
}

export function getInlineTryOnBlockEditorUrl(shopDomain: string): string {
  const apiKey = process.env.SHOPIFY_API_KEY || FALLBACK_THEME_APP_API_KEY;
  return `https://${shopDomain}/admin/themes/current/editor?template=product&addAppBlockId=${apiKey}/${INLINE_TRYON_BLOCK_HANDLE}&target=mainSection`;
}
