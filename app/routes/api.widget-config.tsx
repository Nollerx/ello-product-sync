const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function loader() {
  return new Response(
    JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL || "",
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Values here (Supabase URL + anon key) only change when env vars change,
        // which only happens on a redeploy. Safe to cache aggressively. Browser
        // honors max-age; CDN/edge honors s-maxage.
        "Cache-Control": "public, max-age=86400, s-maxage=86400, immutable",
        ...CORS,
      },
    }
  );
}
