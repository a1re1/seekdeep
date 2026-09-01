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
    for (const f of ['index.html', 'main.js', 'styles.css', '.nojekyll', join('samples', 'claude-code.jsonl')]) {
      expect(existsSync(join(out, f))).toBe(true);
    }
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).not.toMatch(/(src|href)="\//);
    expect(html).toMatch(/src="\.\/main\.js"/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
