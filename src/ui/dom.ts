// Small DOM helpers: element construction, canvas sizing, color lookup.

export function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
}

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | EventListener> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs !== null) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value as EventListener);
      } else if (key === 'hidden' || key === 'disabled' || key === 'checked' || key === 'selected') {
        (node as unknown as Record<string, unknown>)[key] = Boolean(value);
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Size a canvas's backing store to its CSS box × devicePixelRatio. */
export function sizeCanvas(canvas: HTMLCanvasElement): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round((rect.width || canvas.width) * dpr));
  const h = Math.max(1, Math.round((rect.height || canvas.height) * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

/**
 * Resolve a custom property to a paintable value. Kind colors are aliases
 * (`--c-model: var(--green)`) and canvas/SVG cannot take `var()`, so follow
 * the indirection a few hops before giving up.
 */
export function cssVar(name: string, fallback: string): string {
  const styles = getComputedStyle(document.documentElement);
  let value = styles.getPropertyValue(name).trim();
  for (let hop = 0; hop < 4; hop += 1) {
    const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(value);
    if (ref === null) break;
    const next = styles.getPropertyValue(ref[1]!).trim();
    value = next.length > 0 ? next : (ref[2] ?? '').trim();
  }
  return value.length > 0 && !value.startsWith('var(') ? value : fallback;
}

export function kindColor(kind: string): string {
  switch (kind) {
    case 'model':
      return cssVar('--c-model', '#f97316');
    case 'tool':
      return cssVar('--c-tool', '#3b82f6');
    case 'turn':
      return cssVar('--c-turn', '#9ca3af');
    case 'subagent':
      return cssVar('--c-subagent', '#a78bfa');
    case 'idle':
      return cssVar('--c-idle', '#e5e7eb');
    default:
      return cssVar('--c-other', '#6b7280');
  }
}
