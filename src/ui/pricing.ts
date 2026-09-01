// Pricing editor: inline-editable table of model → USD-per-1M-token rates.
// Edits persist to localStorage (key seekdeep.pricing) and re-apply pricing.

import type { PricingTable } from '../pricing.ts';
import {
  clearPricingOverrides,
  DEFAULT_PRICING,
  loadPricingOverrides,
  savePricingOverrides,
} from '../pricing.ts';
import { el } from './dom.ts';

const FIELDS = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite5m',
  'cacheWrite1h',
] as const;

export function renderPricingEditor(
  container: HTMLElement,
  table: PricingTable,
  onChange: (table: PricingTable) => void,
): void {
  container.textContent = '';
  const overrides = safeOverrides();

  const rows = Object.keys(table).sort();
  const tableEl = el(
    'table',
    { class: 'detail-table pricing' },
    el(
      'thead',
      null,
      el(
        'tr',
        null,
        el('th', null, 'model'),
        ...FIELDS.map((f) => el('th', null, f)),
      ),
    ),
    el(
      'tbody',
      null,
      ...rows.map((model) => {
        const row = table[model]!;
        const inputs = FIELDS.map((field) => {
          const input = el('input', {
            type: 'number',
            step: 'any',
            min: '0',
            value: String(row[field]),
            'data-model': model,
            'data-field': field,
          }) as HTMLInputElement;
          return input;
        });
        return el('tr', null, el('td', null, model), ...inputs);
      }),
    ),
  );
  container.append(tableEl);

  const commit = (): void => {
    const next: PricingTable = {};
    for (const input of container.querySelectorAll<HTMLInputElement>('input[data-model]')) {
      const model = input.dataset.model ?? '';
      const field = input.dataset.field as (typeof FIELDS)[number];
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

  tableEl.addEventListener('change', () => commit());

  const existing = document.getElementById('pricing-reset');
  if (existing !== null) {
    existing.onclick = (): void => {
      clearPricingOverrides();
      renderPricingEditor(container, DEFAULT_PRICING, onChange);
      onChange({ ...DEFAULT_PRICING });
    };
  }
  void overrides;
}

function safeOverrides(): Record<string, unknown> {
  try {
    return loadPricingOverrides() as Record<string, unknown>;
  } catch {
    return {};
  }
}
