import { join, resolve, sep } from 'node:path';

const root = import.meta.dir; // scripts/
const projectDir = join(root, '..');
const distDir = resolve(projectDir, 'dist');
const port = Number(process.env.PORT ?? 8080);

// Build once up front so dist/ is fresh, then rebuild on each page load so
// edits show up. Concurrent page loads share one in-flight build instead of
// racing over dist/.
let inflight: Promise<void> | null = null;
const build = (): Promise<void> => {
  inflight ??= (async () => {
    const proc = Bun.spawn(['bun', 'run', 'build'], {
      cwd: projectDir,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await proc.exited;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
};

await build();

Bun.serve({
  port,
  hostname: '127.0.0.1', // dev-only server: never expose it on the network
  async fetch(req) {
    const url = new URL(req.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (pathname === '/' || pathname === '/index.html') {
      await build();
      pathname = '/index.html';
    }
    // Resolve inside dist/ and refuse anything that escapes it (`..`, etc.).
    const target = resolve(distDir, `.${pathname}`);
    if (target !== distDir && !target.startsWith(distDir + sep)) {
      return new Response('not found', { status: 404 });
    }
    const file = Bun.file(target);
    if (await file.exists()) return new Response(file);
    return new Response('not found', { status: 404 });
  },
});

console.log(`serving dist/ at http://localhost:${port} (rebuilds on page load)`);
