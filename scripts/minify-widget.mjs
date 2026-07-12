// Post-build: minify the shopper-facing widget bundles.
//
// `react-router build` copies public/ verbatim into build/client, so widget-main.js
// and widget-loader.js otherwise ship UNMINIFIED (comments + indentation included).
// This runs as the npm `postbuild` hook, so it fires automatically inside the Docker
// build right after `npm run build`.
//
// Conservative on purpose: minifyWhitespace + minifySyntax but NOT minifyIdentifiers.
// The widget wires inline HTML handlers to global window.* functions by NAME, and
// name-mangling a ~600KB IIFE is a known footgun (see the widget theme-isolation
// history). Whitespace/comment stripping is the safe, high-value win; any deeper
// identifier mangling must be validated on staging first.
import { transform } from "esbuild";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";

const targets = [
  "build/client/widget-main.js",
  "build/client/widget-loader.js",
];

const kb = (n) => (n / 1024).toFixed(1) + "KB";

for (const target of targets) {
  if (!existsSync(target)) {
    console.log(`[minify-widget] skip (not found): ${target}`);
    continue;
  }
  const src = readFileSync(target, "utf8");
  const before = Buffer.byteLength(src);
  const beforeGz = gzipSync(src).length;

  let out;
  try {
    out = await transform(src, {
      loader: "js",
      minifyWhitespace: true,
      minifySyntax: true,
      minifyIdentifiers: false,
      legalComments: "none",
      target: "es2019",
    });
  } catch (err) {
    // Never fail the build over minification — ship the unminified file instead.
    console.error(`[minify-widget] FAILED for ${target}, leaving as-is:`, err.message);
    continue;
  }

  writeFileSync(target, out.code);
  const after = Buffer.byteLength(out.code);
  const afterGz = gzipSync(out.code).length;
  console.log(
    `[minify-widget] ${target}: raw ${kb(before)}->${kb(after)}, gzip ${kb(beforeGz)}->${kb(afterGz)}`,
  );
}
