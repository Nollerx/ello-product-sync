// Public demo link: auto-submits the storefront password for the demo store
// so prospects can browse it without typing anything. Share <app-url>/demo.

const DEMO_STORE_URL = "https://ello-dev-store.myshopify.com";
const DEMO_STORE_PASSWORD = "Andrew";

export async function loader() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Ello — Live Demo</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #0b0b0f; color: #fff; }
  .card { text-align: center; padding: 2rem; }
  .spinner { width: 28px; height: 28px; margin: 0 auto 1rem; border: 3px solid rgba(255,255,255,0.2);
             border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { color: rgba(255,255,255,0.7); font-size: 0.95rem; }
  a { color: #fff; }
</style>
</head>
<body>
<div class="card">
  <div class="spinner"></div>
  <h1 style="font-size:1.1rem;font-weight:600;margin:0 0 0.4rem;">Taking you to the Ello demo store&hellip;</h1>
  <noscript><p>JavaScript is off — <a href="${DEMO_STORE_URL}/password">open the store</a> and enter password <strong>${DEMO_STORE_PASSWORD}</strong>.</p></noscript>
</div>
<form id="pw" method="post" action="${DEMO_STORE_URL}/password" style="display:none">
  <input type="hidden" name="form_type" value="storefront_password">
  <input type="hidden" name="utf8" value="&#10003;">
  <input type="hidden" name="password" value="${DEMO_STORE_PASSWORD}">
</form>
<script>document.getElementById("pw").submit();</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
