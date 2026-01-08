// app/db.server.ts
import { SQLiteSessionStorage } from "@shopify/shopify-app-session-storage-sqlite";

// Keep this module because the template imports it.
// We are NOT using Prisma in this app.
export const sessionStorage = new SQLiteSessionStorage(
  process.env.SESSION_DB_PATH || "./shopify_sessions.sqlite",
);
