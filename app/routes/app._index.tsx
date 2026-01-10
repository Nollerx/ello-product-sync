import { useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  List,
  ListItem,
  InlineStack,
  Banner,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // We need the API_KEY (Client ID) to construct the Deep Link
  const apiKey = process.env.SHOPIFY_API_KEY;

  // We also need the Extension UUID. 
  // actually, for the deep link `app_id` is the integer ID or Client ID? 
  // It's the Client ID usually for deep linking in context=apps.

  return { shop: session.shop, apiKey };
};

export const action = async ({ request }: LoaderFunctionArgs) => {
  // We keep the action for the sync-token fetcher if needed, 
  // but the sync logic is in a separate route now. 
  return null;
};

export default function Index() {
  const { shop, apiKey } = useLoaderData<typeof loader>();
  const syncFetcher = useFetcher();
  const shopify = useAppBridge();

  // Force sync token on load
  useEffect(() => {
    if (syncFetcher.state === "idle" && !syncFetcher.data) {
      console.log("👉 Triggering token sync check...");
      syncFetcher.submit(null, { method: "POST", action: "/api/sync-token" });
    }
  }, [syncFetcher]);

  const openThemeEditor = () => {
    // This is the Magic Link to open Theme Editor with App Embed enabled
    // We need the Extension UUID. Since we don't have it dynamically easily without querying,
    // we often rely on the user finding it, OR we use the "Clean" generic link.
    // However, the best deep link format is:
    // https://admin.shopify.com/store/{shop}/themes/current/editor?context=apps&app_id={client_id}

    // Extract the handle 'parter-dev-store-2' from 'parter-dev-store-2.myshopify.com'
    const storeHandle = shop.replace(".myshopify.com", "");

    // Note: The 'app_id' param in the URL usually expects the *Extension* ID, not just API Key.
    // If we don't know the Extension ID yet (it's generated on deploy),
    // we can just send them to the general App Embeds tab or just the editor.

    // Let's try the generic "Manage Apps" context which highlights the app.
    const deepLink = `https://admin.shopify.com/store/${storeHandle}/themes/current/editor?context=apps&app_id=${apiKey}`;

    window.open(deepLink, "_blank");
  };

  return (
    <Page title="Ello Virtual Try-On">
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    System Status
                  </Text>
                  <Text as="p" variant="bodyMd">
                    Your store is connected to Ello VTO.
                  </Text>
                  {syncFetcher.data?.success ? (
                    <Banner tone="success">Token Synced Successfully</Banner>
                  ) : syncFetcher.data?.error ? (
                    <Banner tone="critical">Sync Failed: {syncFetcher.data.error}</Banner>
                  ) : (
                    <Banner tone="info">Checking connection...</Banner>
                  )}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Widget Configuration
                  </Text>
                  <Text as="p" variant="bodyMd">
                    To enable the widget on your storefront, you need to turn on the App Embed in your theme editor.
                  </Text>
                </BlockStack>
                <InlineStack gap="300">
                  <Button variant="primary" onClick={openThemeEditor}>
                    Enable on Storefront
                  </Button>
                </InlineStack>
                <Box paddingBlockStart="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Clicking this will open your Theme Editor. Look for "Ello Virtual Try-On" in the App Embeds sidebar (left) and toggle it ON.
                  </Text>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Support
                </Text>
                <List>
                  <ListItem>
                    Documentation
                  </ListItem>
                  <ListItem>
                    Contact Support
                  </ListItem>
                </List>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
