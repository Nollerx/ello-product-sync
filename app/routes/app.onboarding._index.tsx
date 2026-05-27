import { redirect, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getOnboardingState,
  onboardingRouteForStep,
  preserveShopifyQuery,
} from "../lib/onboarding.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const { step } = await getOnboardingState(session.shop);
  const onboardingRoute = onboardingRouteForStep(step);

  if (onboardingRoute) {
    return redirect(`${onboardingRoute}${preserveShopifyQuery(url)}`);
  }
  return redirect(`/app${preserveShopifyQuery(url)}`);
};
