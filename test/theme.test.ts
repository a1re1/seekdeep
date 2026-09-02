import { describe, expect, test } from 'bun:test';
import {
  nextTheme,
  persistTheme,
  resolveInitialTheme,
  THEME_KEY,
  type ThemeStore,
} from '../src/ui/theme.ts';

function fakeStore(initial: Record<string, string> = {}): ThemeStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? (data[k] ?? null) : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe('theme', () => {
  test('nextTheme flips light ⇄ dark', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
  });

  test('resolveInitialTheme prefers the persisted choice', () => {
    expect(resolveInitialTheme(fakeStore({ [THEME_KEY]: 'dark' }), false)).toBe('dark');
    expect(resolveInitialTheme(fakeStore({ [THEME_KEY]: 'light' }), true)).toBe('light');
  });

  test('resolveInitialTheme falls back to the OS preference', () => {
    expect(resolveInitialTheme(fakeStore(), true)).toBe('dark');
    expect(resolveInitialTheme(fakeStore(), false)).toBe('light');
    expect(resolveInitialTheme(fakeStore({ [THEME_KEY]: 'blue' }), true)).toBe('dark');
  });

  test('persistTheme writes the key and tolerates a failing store', () => {
    const store = fakeStore();
    persistTheme('dark', store);
    expect(store.data[THEME_KEY]).toBe('dark');
    const broken: ThemeStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => persistTheme('light', broken)).not.toThrow();
  });
});
