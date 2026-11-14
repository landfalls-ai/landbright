/**
 * The worker: one shape for a person as an HR system describes them, whatever the system. The hris nodes output it and
 * Landbright's `POST /api/v1/people` takes it (the landbright plugin's Person → Create or update).
 *
 * HiBob answers in two shapes, and both are read here:
 *
 * - the flat "machine" format that `POST /people/{id}` and `/people/search` return when fields are named:
 *   `{ "/root/email": { "value": "maya@…" }, "/work/department": { "value": "1234", "humanReadable": "R&D" } }`;
 * - the nested format: `{ "email": "maya@…", "work": { "department": "R&D", "reportsTo": { "email": "…" } } }`
 *   (root fields at the top, or under `root`).
 *
 * List fields (department, title, site) are ids in the machine values; their names are in `humanReadable`, which the
 * requests ask for with `humanReadable: "APPEND"`. Dates come as `YYYY-MM-DD` (or `DD/MM/YYYY` when only the
 * human-readable form is there).
 */
import type { JsonObject } from '@landflow/sdk';

export interface Worker extends JsonObject {
  source: string;
  sourceId: string;
  email: string | null;
  givenName: string | null;
  familyName: string | null;
  displayName: string | null;
  department: string | null;
  title: string | null;
  site: string | null;
  managerEmail: string | null;
  startDate: string | null;
  endDate: string | null;
  /** Lower case, as the HR system says it: `employed`, `hired`, `terminated`, `active`, `inactive`, … */
  status: string | null;
}

/** The fields the nodes ask HiBob for. */
export const HIBOB_FIELDS = [
  'root.id',
  'root.email',
  'root.firstName',
  'root.surname',
  'root.displayName',
  'work.department',
  'work.title',
  'work.site',
  'work.reportsTo',
  'work.startDate',
  'internal.terminationDate',
  'internal.status',
  'internal.lifecycleStatus',
];

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value as text, or null for empty. */
function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** `{ value, humanReadable }` (machine format) → the name when `human`, else the value. */
function unwrap(entry: unknown, human: boolean): unknown {
  if (!isObject(entry) || !('value' in entry || 'humanReadable' in entry)) return entry;
  if (human && entry.humanReadable !== undefined && entry.humanReadable !== null && entry.humanReadable !== '')
    return entry.humanReadable;
  return entry.value;
}

/**
 * A field by its HiBob path (`root.email`, `work.reportsTo`), from either shape. `human` prefers the human-readable
 * form (list fields); otherwise the machine value.
 */
export function field(employee: Raw, path: string, human = false): unknown {
  const flat = `/${path.replaceAll('.', '/')}`;
  if (flat in employee) return unwrap(employee[flat], human);
  const [head, ...rest] = path.split('.');
  // Nested: root fields are at the top (or under `root`); the human-readable copy, when appended, is under `humanReadable`.
  const starts = head === 'root' ? [employee.root, employee] : [employee[head]];
  if (human && isObject(employee.humanReadable)) {
    const readable = employee.humanReadable;
    starts.unshift(head === 'root' ? readable : readable[head]);
  }
  for (const start of starts) {
    let node: unknown = start;
    for (const key of rest) node = isObject(node) ? unwrap(node[key], human) : undefined;
    if (node !== undefined && node !== null && node !== '') return node;
  }
  return undefined;
}

/** `2026-11-21`, `2026-11-21T00:00:00Z` or `21/11/2026` → `2026-11-21`; anything else → null. */
export function isoDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return null;
}

/** The manager's email: `work.reportsTo` is an object with `email` (or only its id, which gives nothing). */
function managerEmail(employee: Raw): string | null {
  const direct = text(field(employee, 'work.reportsTo.email'));
  if (direct) return direct.toLowerCase();
  const reportsTo = field(employee, 'work.reportsTo');
  return isObject(reportsTo) ? (text(reportsTo.email)?.toLowerCase() ?? null) : null;
}

/** A HiBob employee (either shape) as a worker. */
export function workerFromHiBob(employee: Raw): Worker {
  const sourceId = text(field(employee, 'root.id'));
  if (!sourceId) throw new Error('The HiBob employee has no id');
  const givenName = text(field(employee, 'root.firstName'));
  const familyName = text(field(employee, 'root.surname'));
  const status = text(field(employee, 'internal.lifecycleStatus')) ?? text(field(employee, 'internal.status'));
  return {
    source: 'hibob',
    sourceId,
    email: text(field(employee, 'root.email'))?.toLowerCase() ?? null,
    givenName,
    familyName,
    displayName:
      text(field(employee, 'root.displayName')) ?? ([givenName, familyName].filter(Boolean).join(' ') || null),
    department: text(field(employee, 'work.department', true)),
    title: text(field(employee, 'work.title', true)),
    site: text(field(employee, 'work.site', true)),
    managerEmail: managerEmail(employee),
    startDate: isoDate(field(employee, 'work.startDate')),
    endDate: isoDate(field(employee, 'internal.terminationDate')),
    status: status?.toLowerCase() ?? null,
  };
}

/** The changed fields of a v2 event: `fieldUpdates` (`[{ id, … }]` or `[{ fieldId }]`) or `fieldUpdatesIds` (`["work.title"]`). */
export function changedFields(data: unknown): string[] {
  if (!isObject(data)) return [];
  const out = new Set<string>();
  for (const entry of Array.isArray(data.fieldUpdates) ? data.fieldUpdates : []) {
    const id = isObject(entry) ? text(entry.id ?? entry.fieldId ?? entry.fieldPath) : text(entry);
    if (id) out.add(id);
  }
  for (const entry of Array.isArray(data.fieldUpdatesIds) ? data.fieldUpdatesIds : []) {
    const id = isObject(entry) ? text(entry.id) : text(entry);
    if (id) out.add(id);
  }
  return [...out];
}
