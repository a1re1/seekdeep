// Pricing editor: inline-editable grid of model → USD-per-1M-token rates.
// Every built-in row ships with the app; the blank rows underneath add models
// the table does not know about, and the trash button drops one you added.
// Edits persist to localStorage (key seekdeep.pricing) and re-apply pricing
// through `onChange`.

import type { NumericPriceField, PriceRow, PricingOverrides, PricingTable } from '../pricing.ts';
import {
  clearPricingOverrides,
  DEFAULT_PRICING,
  loadPricingOverrides,
  mergePricing,
  savePricingOverrides,
} from '../pricing.ts';
import { el } from './dom.ts';
import { icon } from './icons.ts';

/** Display order of the rate columns; the *set* must match PRICE_FIELDS. */
export const PRICE_EDITOR_FIELDS: Array<[NumericPriceField, string]> = [
  ['input', 'Input'],
  ['cacheRead', 'Cache read'],
  ['cacheWrite5m', 'Cache write 5m'],
  ['cacheWrite1h', 'Cache write 1h'],
  ['output', 'Output'],
];

const FIELDS = PRICE_EDITOR_FIELDS;

/**
 * How many empty rows sit under the table. A row counts as a new model only
 * once its name and all five rates are filled in, so half-typed rows are left
 * alone and a mistyped name cannot silently create a $0 model.
 */
const BLANK_ROWS = 2;

interface RowEntry {
  model: string | null; // null = a blank "add a model" row
}

const ratePatch = (values: Map<NumericPriceField, number>): Partial<PriceRow> => {
  const patch: Partial<PriceRow> = {};
  for (const [field, value] of values) patch[field] = value;
  return patch;
};

export function renderPricingEditor(
  container: HTMLElement,
  table: PricingTable,
  onChange: (table: PricingTable) => void,
): void {
  container.textContent = '';

  // Built-in rows first, then rows the user added, then the blank ones.
  const names = Object.keys(table).sort();
  const custom = new Set(names.filter((model) => !(model in DEFAULT_PRICING)));
  const entries: RowEntry[] = [
    ...names.filter((model) => !custom.has(model)).map((model) => ({ model })),
    ...names.filter((model) => custom.has(model)).map((model) => ({ model })),
    ...Array.from({ length: BLANK_ROWS }, (): RowEntry => ({ model: null })),
  ];

  const grid = el(
    'div',
    { class: 'pricing-grid' },
    el('span', { class: 'section-cap' }, 'Model'),
    ...FIELDS.map(([, label]) => el('span', { class: 'section-cap' }, label)),
    el('span', { class: 'section-cap' }, ''),
  );

  entries.forEach((entry, index) => {
    const name = entry.model;
    const row = name !== null ? table[name] : undefined;
    grid.append(
      name !== null
        ? el('span', { class: 'pricing-model mono footnote', title: name }, name)
        : el(
            'label',
            { class: 'vt-input pricing-input pricing-name' },
            el('input', {
              type: 'text',
              placeholder: 'model-name',
              'aria-label': 'new model name',
              'data-row-name': String(index),
            }),
          ),
    );
    for (const [field, label] of FIELDS) {
      const attrs: Record<string, string> = {
        type: 'number',
        step: 'any',
        min: '0',
        value: row !== undefined ? String(Number(row[field].toPrecision(12))) : '',
        placeholder: label,
        'aria-label': `${name ?? 'new model'} ${field}`,
        'data-row': String(index),
        'data-field': field,
      };
      if (name !== null) attrs['data-model'] = name;
      grid.append(el('label', { class: 'vt-input pricing-input' }, el('input', attrs)));
    }
    grid.append(
      name !== null && custom.has(name)
        ? el(
            'button',
            {
              class: 'vt-btn vt-iconbtn vt-btn--s vt-btn--plain icon-plain',
              type: 'button',
              'data-remove': name,
              'aria-label': `remove ${name}`,
              title: `remove ${name}`,
            },
            icon('trash', 14),
          )
        : el('span', { class: 'pricing-remove' }),
    );
  });
  container.append(grid);

  const status = el('p', { class: 'pricing-status footnote muted' });
  container.append(status);

  /** Read the grid back into overrides; blank/incomplete rows are skipped. */
  const readGrid = (): { overrides: PricingOverrides; pending: string; added: boolean } => {
    const overrides: PricingOverrides = {};
    let pending = '';
    let addedRow = false;
    entries.forEach((entry, index) => {
      const values = new Map<NumericPriceField, number>();
      let touched = false;
      let invalid = false;
      for (const input of grid.querySelectorAll<HTMLInputElement>(`input[data-row="${index}"]`)) {
        const raw = input.value.trim();
        if (raw === '') continue;
        touched = true;
        const value = Number(raw);
        if (Number.isFinite(value) && value >= 0) values.set(input.dataset.field as NumericPriceField, value);
        else invalid = true;
      }
      if (entry.model === null) {
        const nameInput = grid.querySelector<HTMLInputElement>(`input[data-row-name="${index}"]`);
        const name = (nameInput?.value ?? '').trim();
        if (name === '' && !touched) return; // untouched blank row
        if (invalid || name === '' || values.size < FIELDS.length) {
          pending = 'a new row needs a model name and all five rates; it was not saved';
          return;
        }
        overrides[name] = ratePatch(values);
        addedRow = true;
        return;
      }
      if (!touched) return; // fields the user never visited keep their built-in rate
      overrides[entry.model] = ratePatch(values);
    });
    return { overrides, pending, added: addedRow };
  };

  const commit = (): void => {
    const { overrides, pending, added: addedRow } = readGrid();
    status.textContent = pending;
    savePricingOverrides(overrides);
    const next = mergePricing(overrides);
    // A completed new row needs a re-render to become a named, removable row.
    if (addedRow) renderPricingEditor(container, next, onChange);
    onChange(next);
  };

  grid.addEventListener('change', () => commit());

  grid.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest('button[data-remove]');
    if (!(button instanceof HTMLButtonElement)) return;
    const model = button.dataset.remove ?? '';
    const overrides = { ...loadPricingOverrides() };
    delete overrides[model];
    savePricingOverrides(overrides);
    const next = mergePricing(overrides);
    renderPricingEditor(container, next, onChange);
    onChange(next);
  });

  const existing = document.getElementById('pricing-reset');
  if (existing !== null) {
    existing.onclick = (): void => {
      clearPricingOverrides();
      renderPricingEditor(container, DEFAULT_PRICING, onChange);
      onChange({ ...DEFAULT_PRICING });
    };
  }
}
