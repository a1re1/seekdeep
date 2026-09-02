// Pricing editor: inline-editable grid of model → USD-per-1M-token rates.
// Edits persist to localStorage (key seekdeep.pricing) and re-apply pricing.

import type { PricingTable } from '../pricing.ts';
import {
  clearPricingOverrides,
  DEFAULT_PRICING,
  savePricingOverrides,
} from '../pricing.ts';
import { el } from './dom.ts';

const FIELDS: Array<[keyof PricingTable[string], string]> = [
  ['input', 'Input'],
  ['cacheRead', 'Cache read'],
  ['cacheWrite5m', 'Cache write 5m'],
  ['cacheWrite1h', 'Cache write 1h'],
  ['output', 'Output'],
];

export function renderPricingEditor(
  container: HTMLElement,
  table: PricingTable,
  onChange: (table: PricingTable) => void,
): void {
  container.textContent = '';

  const rows = Object.keys(table).sort();
  const grid = el(
    'div',
    { class: 'pricing-grid' },
    el('span', { class: 'section-cap' }, 'Model'),
    ...FIELDS.map(([, label]) => el('span', { class: 'section-cap' }, label)),
    ...rows.flatMap((model) => {
      const row = table[model]!;
      return [
        el('span', { class: 'pricing-model mono footnote', title: model }, model),
        ...FIELDS.map(([field]) =>
          el(
            'label',
            { class: 'vt-input pricing-input' },
            el('input', {
              type: 'number',
              step: 'any',
              min: '0',
              value: String(Number(row[field].toPrecision(12))), // strips float noise (0.30000000000000004) losslessly
              'aria-label': `${model} ${field}`,
              'data-model': model,
              'data-field': field,
            }),
          ),
        ),
      ];
    }),
  );
  container.append(grid);

  const commit = (): void => {
    const next: PricingTable = {};
    for (const input of container.querySelectorAll<HTMLInputElement>('input[data-model]')) {
      const model = input.dataset.model ?? '';
      const field = input.dataset.field as keyof PricingTable[string];
      const cur = next[model] ?? { ...table[model]! };
      // An emptied field must not silently become $0 — restore the rate.
      if (input.value.trim() === '') {
        input.value = String(cur[field]);
        next[model] = cur;
        continue;
      }
      const value = Number(input.value);
      if (Number.isFinite(value) && value >= 0) cur[field] = value;
      next[model] = cur;
    }
    savePricingOverrides(next);
    onChange(next);
  };

  grid.addEventListener('change', () => commit());

  const existing = document.getElementById('pricing-reset');
  if (existing !== null) {
    existing.onclick = (): void => {
      clearPricingOverrides();
      renderPricingEditor(container, DEFAULT_PRICING, onChange);
      onChange({ ...DEFAULT_PRICING });
    };
  }
}
