import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

test('bun run build emits a relocatable static site', async () => {
  const out = mkdtempSync(join(tmpdir(), 'seekdeep-build-'));
  try {
    const proc = Bun.spawn(['bun', 'run', 'scripts/build.ts'], { cwd: root, env: { ...process.env, SEEKDEEP_OUTDIR: out }, stdout: 'pipe', stderr: 'pipe' });
    const code = await proc.exited;
    expect(code).toBe(0);
    for (const f of ['index.html', 'main.js', 'styles.css', '.nojekyll', 'sql-wasm.js', 'sql-wasm.wasm', join('samples', 'claude-code.jsonl')]) {
      expect(existsSync(join(out, f))).toBe(true);
    }
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).not.toMatch(/(src|href)="\//);
    expect(html).toMatch(/src="\.\/main\.js"/);
    // Ids main.ts resolves with byId(): a dropped one breaks the app at runtime.
    for (const id of [
      'drop-zone', 'file-input', 'load-sample', 'drop-status', 'nav-trace', 'nav-activity', 'nav-settings', 'theme-toggle',
      'index-panel', 'app', 'session-tabs', 'back-to-sessions', 'crumb-project', 'crumb-title', 'crumb-meta', 'breadcrumb',
      'summary-panel', 's-wall', 's-model', 's-tool', 's-idle', 's-tokens', 's-hitrate', 's-cost',
      's-wall-sub', 's-model-sub', 's-tool-sub', 's-idle-sub', 's-tokens-sub', 's-hitrate-sub', 's-cost-sub',
      'warnings', 'details-body', 'trace-section', 'expand-default', 'collapse-all', 'expand-all', 'span-count', 'zoom-out',
      'focus-toggle', 'trace', 'cache-canvas', 'trace-splitter', 'detail-pane', 'tooltip',
      'activity', 'activity-host', 'settings', 'pricing-table', 'pricing-reset', 'theme-switch', 'sources-summary', 'sources-rescan',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
