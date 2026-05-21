import { supabaseAdmin } from "./supabase.server";

export type OnboardingStep =
  | "welcome"
  | "activate_widget"
  | "configure"
  | "billing"
  | "complete";

export const ONBOARDING_ROUTE_BY_STEP: Record<Exclude<OnboardingStep, "billing" | "complete">, string> = {
  welcome: "/app/onboarding/welcome",
  configure: "/app/onboarding/configure",
  activate_widget: "/app/onboarding/activate-widget",
};

// Order: welcome → configure (customize color/position) → activate_widget
// (enable in theme so the customized widget shows up) → billing → complete.
const STEP_ORDER: OnboardingStep[] = ["welcome", "configure", "activate_widget", "billing", "complete"];

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
