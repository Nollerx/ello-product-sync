import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { supabaseAdmin } from "./supabase.server";

type SessionRow = {
  id: string;
  shop: string;
  state: string;
  is_online: boolean;
  scope: string | null;
  expires: string | null;
  access_token: string | null;
};

/**
 * Persistent Shopify session storage backed by Supabase.
 * Replaces SQLiteSessionStorage which is ephemeral in Cloud Run.
 * Sessions survive redeployments — merchants never need to re-authorize.
 */
export class SupabaseSessionStorage implements SessionStorage {
  async storeSession(session: Session): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from("shopify_sessions")
        .upsert(
          {
            id: session.id,
            shop: session.shop,
            state: session.state,
            is_online: session.isOnline,
            scope: session.scope ?? null,
            expires: session.expires?.toISOString() ?? null,
            access_token: session.accessToken ?? null,
          },
          { onConflict: "id" }
        );

      if (error) {
        console.error("[SessionStorage] storeSession error:", error.message);
        return false;
      }
      return true;
    } catch (err) {
      console.error("[SessionStorage] storeSession exception:", err);
      return false;
    }
  }

  async loadSession(id: string): Promise<Session | undefined> {
    try {
      const { data, error } = await supabaseAdmin
        .from("shopify_sessions")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (error || !data) return undefined;
      return this.rowToSession(data as SessionRow);
    } catch (err) {
      console.error("[SessionStorage] loadSession exception:", err);
      return undefined;
    }
  }

  async deleteSession(id: string): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from("shopify_sessions")
        .delete()
        .eq("id", id);
      return !error;
    } catch {
      return false;
    }
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from("shopify_sessions")
        .delete()
        .in("id", ids);
      return !error;
    } catch {
      return false;
    }
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from("shopify_sessions")
        .select("*")
        .eq("shop", shop);

      if (error || !data) return [];
      return (data as SessionRow[]).map((row) => this.rowToSession(row));
    } catch {
      return [];
    }
  }

  private rowToSession(row: SessionRow): Session {
    const session = new Session({
      id: row.id,
      shop: row.shop,
      state: row.state,
      isOnline: row.is_online,
    });

    if (row.scope) session.scope = row.scope;
    if (row.access_token) session.accessToken = row.access_token;
    if (row.expires) session.expires = new Date(row.expires);

    return session;
  }
}
