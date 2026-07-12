import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  Box,
  InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query BillingDebugActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        createdAt
        currentPeriodEnd
        returnUrl
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                interval
                price {
                  amount
                  currencyCode
                }
              }
              ... on AppUsagePricing {
                balanceUsed {
                  amount
                  currencyCode
                }
                cappedAmount {
                  amount
                  currencyCode
                }
                terms
              }
            }
          }
        }
      }
    }
  }
`;

export async function loader({ request }: LoaderFunctionArgs) {
  const { billing, admin, session } = await authenticate.admin(request);

  const [billingCheck, subscriptionsResponse] = await Promise.all([
    billing.check(),
    admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY),
  ]);

  const subscriptionsJson = (await subscriptionsResponse.json()) as {
    data?: {
      currentAppInstallation?: {
        activeSubscriptions?: unknown[] | null;
      } | null;
    } | null;
    errors?: unknown;
  };

  return {
    shop: session.shop,
    checkedAt: new Date().toISOString(),
    billingCheck,
    activeSubscriptions:
      subscriptionsJson?.data?.currentAppInstallation?.activeSubscriptions ?? [],
    graphqlErrors: subscriptionsJson?.errors ?? null,
  };
}

function JsonCard({
  title,
  data,
}: {
  title: string;
  data: unknown;
}) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">{title}</Text>
        <Box
          padding="400"
          background="bg-surface-secondary"
          borderRadius="200"
          overflowX="scroll"
        >
          <pre style={{ margin: 0 }}>
            <code>{JSON.stringify(data, null, 2)}</code>
          </pre>
        </Box>
      </BlockStack>
    </Card>
  );
}

export default function BillingDebugPage() {
  const data = useLoaderData<typeof loader>();

  return (
    <Page title="Billing Debug">
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              Use this page immediately after approving billing to verify whether Shopify is reporting the subscription yet.
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Shop: {data.shop} · Checked at: {data.checkedAt}
            </Text>
            <InlineStack gap="300">
              <Button onClick={() => window.location.reload()} variant="primary">Refresh</Button>
              <Button url="/app/billing" variant="plain">Back to billing</Button>
            </InlineStack>
          </BlockStack>
        </Card>

        <Layout>
          <Layout.Section>
            <JsonCard title="billing.check()" data={data.billingCheck} />
          </Layout.Section>
          <Layout.Section>
            <JsonCard
              title="currentAppInstallation.activeSubscriptions"
              data={{
                activeSubscriptions: data.activeSubscriptions,
                graphqlErrors: data.graphqlErrors,
              }}
            />
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
