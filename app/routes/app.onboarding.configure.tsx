import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useNavigation } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  ButtonGroup,
  ProgressBar,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../lib/supabase.server";
import { preserveShopifyQuery, setOnboardingStep } from "../lib/onboarding.server";

const COLOR_PRESETS = [
  "#111827", // near-black
  "#1E3A8A", // deep blue
  "#2563EB", // bright blue
  "#10B981", // emerald
  "#DB2777", // pink
  "#F97316", // orange
];

const DEFAULT_COLOR = "#111827";

function normalizeHex(input: string): string {
  const trimmed = input.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  return DEFAULT_COLOR;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { data } = await supabaseAdmin
    .from("vto_stores")
    .select("widget_position, minimized_color, widget_primary_color")
    .eq("shop_domain", session.shop)
    .maybeSingle();
  // The storefront button is painted from `minimized_color` (read by the
  // widget). `widget_primary_color` is a separate brand-color field used
  // elsewhere; we keep it in sync so dashboard surfaces stay consistent.
  return {
    widgetPosition: (data?.widget_position as "left" | "right" | null) ?? "right",
    widgetColor: data?.minimized_color ?? data?.widget_primary_color ?? DEFAULT_COLOR,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const form = await request.formData();
  const widgetPosition = form.get("widget_position") === "left" ? "left" : "right";
  const widgetColor = normalizeHex(String(form.get("widget_color") ?? DEFAULT_COLOR));

  await supabaseAdmin
    .from("vto_stores")
    .update({
      widget_position: widgetPosition,
      minimized_color: widgetColor,
      widget_primary_color: widgetColor,
    })
    .eq("shop_domain", session.shop);

  await setOnboardingStep(session.shop, "activate_widget");
  return redirect(`/app/onboarding/activate-widget${preserveShopifyQuery(url)}`);
};

function StorefrontPreview({ position, color }: { position: "left" | "right"; color: string }) {
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        maxWidth: "420px",
        aspectRatio: "16 / 10",
        borderRadius: "12px",
        border: "1px solid #E1E3E5",
        background: "#FAFBFB",
        overflow: "hidden",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      {/* Browser chrome */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "8px 12px",
          borderBottom: "1px solid #E1E3E5",
          background: "#fff",
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 4, background: "#FF5F57" }} />
        <span style={{ width: 8, height: 8, borderRadius: 4, background: "#FEBC2E" }} />
        <span style={{ width: 8, height: 8, borderRadius: 4, background: "#28C840" }} />
      </div>

      {/* Product layout placeholder */}
      <div style={{ display: "flex", gap: "10px", padding: "14px" }}>
        <div
          style={{
            flex: "0 0 45%",
            aspectRatio: "3 / 4",
            background: "linear-gradient(135deg,#E4E5E7 0%,#D2D5DA 100%)",
            borderRadius: "8px",
          }}
        />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px", paddingTop: "4px" }}>
          <div style={{ height: 10, width: "70%", background: "#D2D5DA", borderRadius: 3 }} />
          <div style={{ height: 8, width: "40%", background: "#E1E3E5", borderRadius: 3 }} />
          <div style={{ height: 8, width: "55%", background: "#E1E3E5", borderRadius: 3, marginTop: 6 }} />
          <div style={{ height: 28, width: "70%", background: "#111827", borderRadius: 6, marginTop: 10 }} />
        </div>
      </div>

      {/* The widget button */}
      <div
        style={{
          position: "absolute",
          bottom: "14px",
          [position === "left" ? "left" : "right"]: "14px",
          width: "44px",
          height: "44px",
          borderRadius: "50%",
          background: color,
          boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontSize: "18px",
          transition: "left 220ms ease, right 220ms ease, background 220ms ease",
        }}
      >
        ✨
      </div>
    </div>
  );
}

function ColorSwatch({
  value,
  selected,
  onClick,
}: {
  value: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Use color ${value}`}
      style={{
        width: 36,
        height: 36,
        borderRadius: "50%",
        background: value,
        border: selected ? "3px solid #2563EB" : "2px solid #E1E3E5",
        cursor: "pointer",
        padding: 0,
        boxShadow: selected ? "0 0 0 2px #fff inset" : undefined,
        transition: "border-color 120ms ease",
      }}
    />
  );
}

export default function OnboardingConfigure() {
  const { widgetPosition: initialPosition, widgetColor: initialColor } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  const [position, setPosition] = useState<"left" | "right">(initialPosition);
  const [color, setColor] = useState<string>(initialColor || DEFAULT_COLOR);

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 20,
              minHeight: "calc(100vh - 120px)",
            }}
          >
            <Box>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">Step 2 of 4</Text>
                <ProgressBar progress={50} size="small" />
              </BlockStack>
            </Box>

            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
              }}
            >
              <div style={{ width: "100%" }}>
              <Card>
              <BlockStack gap="600">
                <BlockStack gap="200">
                  <Text as="h1" variant="headingXl">Customize your widget</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Set the position and color of the Try-On button. You can change these anytime.
                  </Text>
                </BlockStack>

                {/* Live preview */}
                <Box>
                  <InlineStack align="center">
                    <StorefrontPreview position={position} color={color} />
                  </InlineStack>
                </Box>

                {/* Position */}
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Widget position</Text>
                  <ButtonGroup variant="segmented">
                    <Button
                      pressed={position === "left"}
                      onClick={() => setPosition("left")}
                    >
                      Bottom left
                    </Button>
                    <Button
                      pressed={position === "right"}
                      onClick={() => setPosition("right")}
                    >
                      Bottom right
                    </Button>
                  </ButtonGroup>
                </BlockStack>

                {/* Color */}
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Widget color</Text>
                  <InlineStack gap="300" blockAlign="center" wrap>
                    {COLOR_PRESETS.map((preset) => (
                      <ColorSwatch
                        key={preset}
                        value={preset}
                        selected={color.toLowerCase() === preset.toLowerCase()}
                        onClick={() => setColor(preset)}
                      />
                    ))}
                    <Box>
                      <InlineStack gap="200" blockAlign="center">
                        <label
                          htmlFor="custom-color"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            cursor: "pointer",
                            padding: "6px 10px",
                            borderRadius: 8,
                            border: "1px solid #E1E3E5",
                            background: "#fff",
                          }}
                        >
                          <span
                            style={{
                              width: 20,
                              height: 20,
                              borderRadius: 4,
                              background: color,
                              border: "1px solid #E1E3E5",
                            }}
                          />
                          <span style={{ fontSize: 13, color: "#202223" }}>Custom</span>
                          <input
                            id="custom-color"
                            type="color"
                            value={color}
                            onChange={(e) => setColor(e.target.value)}
                            style={{ width: 0, height: 0, opacity: 0, position: "absolute" }}
                          />
                        </label>
                        <Text as="span" variant="bodySm" tone="subdued">{color.toUpperCase()}</Text>
                      </InlineStack>
                    </Box>
                  </InlineStack>
                </BlockStack>

                <Text as="p" variant="bodySm" tone="subdued">
                  Storefront updates appear within a minute.
                </Text>
              </BlockStack>
              </Card>
              </div>
            </div>

            <InlineStack align="end">
              <Form method="post">
                <input type="hidden" name="widget_position" value={position} />
                <input type="hidden" name="widget_color" value={color} />
                <Button submit variant="primary" size="large" loading={submitting}>
                  Continue
                </Button>
              </Form>
            </InlineStack>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
