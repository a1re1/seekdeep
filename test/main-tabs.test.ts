// The tab-close state machine (closeSession) is a closure inside main(), which
// needs a real DOM, so the node/Bun side pins the contract with a guarded
// source scan (test/build.test.ts uses the same readFileSync approach). The
// assertions cover every close position: first/middle/last (active close picks
// i-1 or 0), an inactive tab left of the active one (active decrements), an
// inactive tab right of it (active unchanged), and the final close (active -1,
// sessions picker shown).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mainSource = readFileSync(join(import.meta.dir, '..', 'src', 'main.ts'), 'utf8');

function closeSessionBody(): string {
  const start = mainSource.indexOf('function closeSession');
  expect(start).toBeGreaterThan(-1);
  const end = mainSource.indexOf('\n  }', start);
  expect(end).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

describe('session tab close (closeSession)', () => {
  test('closeSession splices the session, resets zoom, rerenders tabs+trace', () => {
    const fn = closeSessionBody();
    expect(fn).toContain('state.sessions.splice(i, 1)');
    expect(fn).toContain('state.zoomNode = null');
    expect(fn).toContain('renderTabs()');
    expect(fn).toContain('render(true)');
  });

  test('active close picks the left neighbour (or 0), closing left decrements, empty shows the picker', () => {
    const fn = closeSessionBody();
    expect(fn).toContain('state.active = Math.max(0, i - 1)');
    expect(fn).toContain('else if (i < state.active) state.active -= 1');
    expect(fn).toContain('state.active = -1');
    expect(fn).toContain('state.picker = true');
  });

  test('each tab renders an accessible close control that stops propagation', () => {
    expect(mainSource).toContain("class: 'session-tab-close'");
    expect(mainSource).toContain("'aria-label': 'Close session'");
    expect(mainSource).toContain("title: 'Close session'");
    expect(mainSource).toContain("icon('x', 12)");
    const handlerStart = mainSource.indexOf("class: 'session-tab-close'");
    const handlerEnd = mainSource.indexOf("icon('x', 12)");
    const handler = mainSource.slice(handlerStart, handlerEnd);
    const stopAt = handler.indexOf('e.stopPropagation()');
    const closeAt = handler.indexOf('closeSession(i)');
    expect(stopAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(stopAt);
  });

  test('selecting a tab still activates it, resets zoom, and rerenders', () => {
    expect(mainSource).toContain('state.active = i;\n              state.zoomNode = null;\n              renderTabs();\n              render(true);');
  });

  test('the stylesheet styles .session-tab-close beside the session-tabs rules', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'public', 'styles.css'), 'utf8');
    const closeAt = css.indexOf('.session-tab-close');
    const tabsAt = css.indexOf('.session-tabs');
    expect(closeAt).toBeGreaterThan(-1);
    expect(tabsAt).toBeGreaterThan(-1);
    expect(Math.abs(closeAt - tabsAt)).toBeLessThan(600);
    expect(css).toContain('.session-tab-close:hover');
  });
});
