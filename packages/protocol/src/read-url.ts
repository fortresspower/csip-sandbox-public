export interface ReadRequest { mup: 0 | 1; after?: number; start: number; limit: number; mrids?: string[]; }
export interface ParsedRead { after?: number; start: number; limit: number; mrids?: string[]; }

export const READ_LIMIT_DEFAULT = 50;
export const READ_LIMIT_CAP = 200;

/** Canonical §4.6.2 read URL — the one builder client/console/tests share. */
export function buildReadUrl(r: ReadRequest): string {
  const q: string[] = [];
  if (r.after !== undefined) q.push(`a=${r.after}`);
  q.push(`s=${r.start}`);
  q.push(`l=${r.limit}`);
  for (const m of r.mrids ?? []) q.push(`mrid=${encodeURIComponent(m)}`);
  return `/mup/${r.mup}/mr?${q.join('&')}`;
}

/** Normalize an Express-style query object into a ParsedRead (defaults + caps). */
export function parseReadQuery(q: Record<string, string | string[] | undefined>): ParsedRead {
  const num = (v: unknown) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  };
  const after = num(q.a);
  const start = Math.max(0, num(q.s) ?? 0);
  const limit = Math.min(READ_LIMIT_CAP, Math.max(1, num(q.l) ?? READ_LIMIT_DEFAULT));
  const mrids = q.mrid === undefined ? undefined : (Array.isArray(q.mrid) ? q.mrid : [q.mrid]);
  return { after: after !== undefined && !Number.isNaN(after) ? after : undefined, start, limit, mrids };
}
