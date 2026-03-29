/**
 * Re-applies patches to node_modules that are required for Bun compatibility.
 * Run automatically after `bun install` via the "postinstall" script in package.json.
 */

import { writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')

function patch(relPath: string, content: string, description: string) {
  const abs = join(ROOT, relPath)
  if (!existsSync(abs)) {
    console.warn(`[postinstall] SKIP — file not found: ${relPath}`)
    return
  }
  writeFileSync(abs, content, 'utf-8')
  console.log(`[postinstall] Patched ${relPath} — ${description}`)
}

// ── Patch 1: webtorrent/lib/utp.cjs ────────────────────────────────────────
// utp-native uses uv_timer_init which Bun doesn't support yet.
// Returning {} causes webtorrent to fall back to TCP-only peer connections.
// Tracking issue: https://github.com/oven-sh/bun/issues/18546
patch(
  'node_modules/webtorrent/lib/utp.cjs',
  `// Patched by scripts/postinstall.ts for Bun compatibility.
// utp-native calls uv_timer_init which Bun doesn't support yet.
// https://github.com/oven-sh/bun/issues/18546
// WebTorrent falls back to TCP-only peer connections.
module.exports = {}
`,
  'disable utp-native (Bun uv_timer_init compat)',
)

console.log('[postinstall] Done.')
