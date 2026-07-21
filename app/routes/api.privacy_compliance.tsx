// Legacy path — the real handler (HMAC verify + shop/redact purge) lives at
// /api/privacy, which is the URI registered in shopify.app.toml's
// compliance_topics. Kept as an alias so anything that ever probed this old
// path keeps working.
export { loader, action } from "./api.privacy";
