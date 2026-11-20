// WAVE AI — bundle the frontend (public/) into the Worker script.
//
// The Cloudflare Workers Script Upload API cannot take static assets, so
// deployment via the API (scripts/cloudflare_api_deploy.py) needs the
// frontend inside the script bundle. This script reads every file under
// public/ and generates src/assets.js: a map of URL path ->
// { content, contentType }. src/index.js serves pages and static files
// from that map instead of env.ASSETS.
//
// Run: `npm run build` (also bundles src/index.js with esbuild).
// The generated src/assets.js is committed so `npm run dev` works on a
// fresh clone without building first — but re-run the build after any
// change under public/, or the bundle goes stale.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const OUT_FILE = join(ROOT, 'src', 'assets.js');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, out);
    } else if (!entry.name.startsWith('_')) {
      // Files starting with "_" are Cloudflare config (e.g. _headers),
      // not servable assets. The security headers from _headers are
      // already set by the Worker's middleware (see src/index.js).
      out.push(full);
    }
  }
  return out;
}

const files = (await collect(PUBLIC_DIR)).sort();
const entries = [];
let totalBytes = 0;

for (const file of files) {
  const buf = await readFile(file);
  const content = buf.toString('utf8');
  // Guard against binary files: only valid UTF-8 can be embedded as a
  // JS string. (All current frontend files are HTML/CSS/JS text.)
  if (!Buffer.from(content, 'utf8').equals(buf)) {
    throw new Error(
      `Cannot bundle ${relative(ROOT, file)}: not valid UTF-8 text. ` +
        'Add binary-asset support (base64) or remove the file.'
    );
  }
  const urlPath = '/' + relative(PUBLIC_DIR, file).split(sep).join('/');
  const contentType =
    CONTENT_TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  entries.push([urlPath, content, contentType]);
  totalBytes += buf.length;
}

const lines = [
  '// GENERATED FILE — do not edit by hand.',
  '// Generated from public/ by scripts/build-assets.mjs (runs as part of',
  '// `npm run build`). The Worker serves its frontend from this map; see',
  '// serveAsset() in src/index.js.',
  '',
  '// URL path -> { content, contentType }',
  'export const ASSETS = {',
];
for (const [urlPath, content, contentType] of entries) {
  lines.push(
    `  ${JSON.stringify(urlPath)}: { content: ${JSON.stringify(content)}, ` +
      `contentType: ${JSON.stringify(contentType)} },`
  );
}
lines.push('};', '');
await writeFile(OUT_FILE, lines.join('\n'), 'utf8');

console.log(
  `Bundled ${entries.length} files (${totalBytes} bytes) from public/ -> src/assets.js`
);
