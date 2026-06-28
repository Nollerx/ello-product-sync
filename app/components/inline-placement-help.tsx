import { useState } from "react";
import { Box, Button, Collapsible, BlockStack, Text, List } from "@shopify/polaris";

// Plain-language guide for placing the inline Try-On button under "Add to cart".
// Shopify's install deep link can't drop an app block inside a nested-theme
// (Horizon) buy-buttons group, so the last step is a quick drag — these steps
// make that obvious for a non-technical merchant. Shared by the dashboard
// Storefront card and the onboarding placements step so the wording never drifts.
export function InlineButtonPlacementHelp() {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <Button
        variant="plain"
        disclosure={open ? "up" : "down"}
        onClick={() => setOpen((v) => !v)}
      >
        How do I put the Try-On button under &ldquo;Add to cart&rdquo;?
      </Button>
      <Collapsible id="ello-inline-placement-help" open={open}>
        <Box paddingBlockStart="200" paddingInlineStart="200">
          <BlockStack gap="200">
            <Text as="p" variant="bodySm" tone="subdued">
              On newer themes (like Horizon), Add to cart sits in its own group, so the
              last step is a quick drag — about 5 seconds:
            </Text>
            <List type="number">
              <List.Item>
                Click <Text as="span" fontWeight="semibold">Add inline button</Text> — it opens your
                theme editor with the button already added.
              </List.Item>
              <List.Item>
                In the <Text as="span" fontWeight="semibold">left sidebar</Text>, find{" "}
                <Text as="span" fontWeight="semibold">Ello Inline Try-On</Text> (it&rsquo;ll be near the
                bottom of the product list).
              </List.Item>
              <List.Item>
                Hover over it and grab the <Text as="span" fontWeight="semibold">six dots (⠿)</Text>{" "}
                that appear on its left.
              </List.Item>
              <List.Item>
                Drag it up and drop it{" "}
                <Text as="span" fontWeight="semibold">right under &ldquo;Buy buttons.&rdquo;</Text>
              </List.Item>
              <List.Item>
                Click <Text as="span" fontWeight="semibold">Save</Text> (top-right). Done — it now sits
                under Add to cart. You can move it anytime.
              </List.Item>
            </List>
            <Text as="p" variant="bodySm" tone="subdued">
              Can&rsquo;t drag it in? Delete that block, then use{" "}
              <Text as="span" fontWeight="semibold">＋ Add block</Text> inside the Buy buttons group →{" "}
              <Text as="span" fontWeight="semibold">Apps</Text> →{" "}
              <Text as="span" fontWeight="semibold">Ello Inline Try-On</Text>.
            </Text>
          </BlockStack>
        </Box>
      </Collapsible>
    </Box>
  );
}
