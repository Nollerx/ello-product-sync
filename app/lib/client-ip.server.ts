// Client-IP extraction that stays correct whether widget traffic arrives
// directly (browser → Google Front End) or through the Cloudflare CDN
// hostname (browser → Cloudflare → GFE).
//
// GFE appends the IP of ITS immediate peer as the LAST entry of
// X-Forwarded-For; every earlier entry is client-supplied and spoofable.
//   - Direct:  last entry = the shopper                → use it.
//   - Via CF:  last entry = a Cloudflare edge IP       → the shopper is in
//     CF-Connecting-IP. That header is only trustworthy when the verified
//     peer really is Cloudflare — anyone hitting the run.app URL directly
//     can send a fake CF-Connecting-IP, but they can't fake their peer IP.
//
// Ranges from https://www.cloudflare.com/ips/ (change rarely; revisit if CF
// announces additions).
const CLOUDFLARE_CIDRS = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
];

type ParsedIp = { value: bigint; width: 32 | 128 };

function parseIpv4(ip: string): bigint | null {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let value = 0n;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const n = BigInt(part);
        if (n > 255n) return null;
        value = (value << 8n) | n;
    }
    return value;
}

function parseIpv6(ip: string): bigint | null {
    let s = ip;
    // IPv4-mapped tail, e.g. ::ffff:104.16.0.1 — parse the dotted quad
    // separately and splice its 32 bits in at the end.
    let v4Tail: bigint | null = null;
    if (s.includes(".")) {
        const lastColon = s.lastIndexOf(":");
        v4Tail = parseIpv4(s.slice(lastColon + 1));
        if (v4Tail === null) return null;
        s = s.slice(0, lastColon) + ":0:0";
    }
    const halves = s.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
    const groups =
        halves.length === 2 ? [...head, ...Array(missing).fill("0"), ...tail] : head;
    if (groups.length !== 8) return null;
    let value = 0n;
    for (const group of groups) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
        value = (value << 16n) | BigInt(parseInt(group, 16));
    }
    if (v4Tail !== null) value = (value & ~0xffffffffn) | v4Tail;
    return value;
}

function parseIp(ip: string): ParsedIp | null {
    if (ip.includes(":")) {
        const value = parseIpv6(ip);
        return value === null ? null : { value, width: 128 };
    }
    const value = parseIpv4(ip);
    return value === null ? null : { value, width: 32 };
}

// Pre-shift the range bases once at module load; per-request work is then a
// parse + a handful of BigInt compares.
const CF_RANGES = CLOUDFLARE_CIDRS.flatMap((cidr) => {
    const [base, bitsStr] = cidr.split("/");
    const parsed = parseIp(base);
    if (!parsed) return [];
    const shift = BigInt(parsed.width - Number(bitsStr));
    return [{ prefix: parsed.value >> shift, shift, width: parsed.width }];
});

function matchesCfRange(parsed: ParsedIp): boolean {
    return CF_RANGES.some(
        (r) => r.width === parsed.width && parsed.value >> r.shift === r.prefix,
    );
}

export function isCloudflareIp(ip: string): boolean {
    const parsed = parseIp(ip);
    if (!parsed) return false;
    if (matchesCfRange(parsed)) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — compare the embedded v4 address
    // against the v4 ranges as well.
    if (parsed.width === 128 && parsed.value >> 32n === 0xffffn) {
        return matchesCfRange({ value: parsed.value & 0xffffffffn, width: 32 });
    }
    return false;
}

// The IP the per-shopper rate limit keys on. Unparseable or absent headers
// fall back to the verified peer itself — never to a spoofable earlier entry.
export function clientIpForRateLimit(request: Request): string | null {
    const xffParts = (request.headers.get("x-forwarded-for") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const verifiedPeer = xffParts.length ? xffParts[xffParts.length - 1] : null;
    if (!verifiedPeer) return null;
    if (isCloudflareIp(verifiedPeer)) {
        return request.headers.get("cf-connecting-ip") || verifiedPeer;
    }
    return verifiedPeer;
}
