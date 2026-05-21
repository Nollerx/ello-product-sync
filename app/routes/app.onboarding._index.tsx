import { redirect, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  ONBOARDING_ROUTE_BY_STEP,
  getOnboardingState,
  preserveShopifyQuery,
} from "../lib/onboarding.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const { step } = await getOnboardingState(session.shop);

  if (step === "welcome" || step === "activate_widget" || step === "configure") {
    return redirect(`${ONBOARDING_ROUTE_BY_STEP[step]}${preserveShopifyQuery(url)}`);
  }
  return redirect(`/app${preserveShopifyQuery(url)}`);
};
