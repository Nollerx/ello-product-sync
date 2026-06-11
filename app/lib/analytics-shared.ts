// Client-safe analytics types + constants shared between the admin pages
// (client components) and the server data layer. Keep this file free of any
// server-only imports — route components reference it directly.

export type ExportCategory = "tryons" | "widget_events" | "cart_events" | "purchases" | "sessions";

export const EXPORT_CATEGORIES: Array<{ key: ExportCategory; label: string }> = [
  { key: "tryons", label: "Try-on events" },
  { key: "widget_events", label: "Widget events" },
  { key: "cart_events", label: "Cart events" },
  { key: "purchases", label: "Purchases" },
  { key: "sessions", label: "Sessions (aggregated)" },
];

export interface Insight {
  tone: "success" | "warning" | "critical" | "info";
  title: string;
  body: string;
}
