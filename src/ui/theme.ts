// Manual theme handling for the Vitrine restyle: `data-theme="dark"` on
// <html>, persisted in localStorage under `seekdeep.theme`. The pure helpers
// take an injectable storage-like object so they are unit-testable outside a
// browser DOM.

export type Theme = 'light' | 'dark';

export const THEME_KEY = 'seekdeep.theme';

export type ThemeStore = Pick<Storage, 'getItem' | 'setItem'>;

/** The next theme in the cycle (light ⇄ dark). */
export function nextTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}

/** Theme to start with: the persisted choice, else the OS preference. */
export function resolveInitialTheme(store: ThemeStore, prefersDark: boolean): Theme {
  const saved = store.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return prefersDark ? 'dark' : 'light';
}

/** Persist the user's explicit choice (best effort). */
export function persistTheme(theme: Theme, store: ThemeStore): void {
  try {
    store.setItem(THEME_KEY, theme);
  } catch {
    // Storage unavailable: the theme still applies for this visit.
  }
}

/** Reflect a theme onto <html> (dark sets data-theme, light removes it). */
export function applyTheme(theme: Theme, doc: Document = document): void {
  if (theme === 'dark') doc.documentElement.setAttribute('data-theme', 'dark');
  else doc.documentElement.removeAttribute('data-theme');
}

/** Read the theme currently reflected on <html>. */
export function currentTheme(doc: Document = document): Theme {
  return doc.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Apply the persisted (or OS) theme; returns the theme that was applied. */
export function initTheme(doc: Document = document, store: ThemeStore = localStorage): Theme {
  const prefersDark = doc.defaultView?.matchMedia('(prefers-color-scheme: dark)').matches ?? false;
  const theme = resolveInitialTheme(store, prefersDark);
  applyTheme(theme, doc);
  return theme;
}

/** Flip the theme, persist it, and return the new one. */
export function toggleTheme(doc: Document = document, store: ThemeStore = localStorage): Theme {
  const theme = nextTheme(currentTheme(doc));
  applyTheme(theme, doc);
  persistTheme(theme, store);
  return theme;
}
