import { resolve, join } from 'path';
import { existsSync } from 'fs';

const DIST_UI_DIR = resolve(import.meta.dir, '../dist/ui');

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function getContentType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Serve a static asset from dist/ui/.
 * Only handles paths starting with `/assets/`.
 * Returns null if the path doesn't match or the file doesn't exist.
 */
export function serveStaticAsset(pathname: string): Response | null {
  if (!pathname.startsWith('/assets/')) return null;

  const relative = pathname.slice('/assets/'.length);
  if (!relative || relative.includes('..')) return null;

  const resolved = resolve(join(DIST_UI_DIR, relative));

  // Prevent path traversal
  if (!resolved.startsWith(DIST_UI_DIR + '/')) return null;

  if (!existsSync(resolved)) return null;

  return new Response(Bun.file(resolved), {
    headers: {
      'content-type': getContentType(resolved),
      'cache-control': 'public, max-age=3600, immutable',
    },
  });
}
