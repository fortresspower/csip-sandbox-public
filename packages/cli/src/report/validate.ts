/**
 * A small validator for the checked-in evidence schema.
 *
 * The toolkit takes no runtime dependency, so this covers exactly the JSON Schema keywords
 * `schemas/fortress-csip-evidence-v1.schema.json` actually uses — and fails loudly on one it
 * does not understand, so the schema and the validator cannot silently drift apart.
 *
 * It runs before an evidence artifact is written, not only in tests: a report that does not
 * match its own published schema is a report a partner cannot rely on, and catching that at
 * generation time is much cheaper than catching it during a Fortress handoff review.
 */

const SUPPORTED_KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', 'type', 'const', 'enum', 'required',
  'additionalProperties', 'properties', 'items', 'pattern', 'maxLength', 'minimum',
  'maxItems', 'format',
]);

export interface SchemaViolation {
  /** JSON pointer to the offending value. */
  path: string;
  message: string;
}

export function validateAgainstSchema(value: unknown, schema: unknown): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  walk(value, schema, '', violations);
  return violations;
}

function walk(value: unknown, schema: unknown, path: string, out: SchemaViolation[]): void {
  if (typeof schema !== 'object' || schema === null) return;
  const rules = schema as Record<string, unknown>;

  for (const keyword of Object.keys(rules)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      out.push({ path, message: `schema uses unsupported keyword "${keyword}"` });
    }
  }

  if ('const' in rules && value !== rules.const) {
    out.push({ path, message: `expected ${JSON.stringify(rules.const)}` });
    return;
  }
  if (Array.isArray(rules.enum) && !rules.enum.includes(value as never)) {
    out.push({ path, message: `expected one of ${rules.enum.map((entry) => JSON.stringify(entry)).join(', ')}` });
    return;
  }
  if (typeof rules.type === 'string' && !matchesType(value, rules.type)) {
    out.push({ path, message: `expected type ${rules.type}, got ${describeType(value)}` });
    return;
  }

  if (typeof value === 'string') {
    if (typeof rules.pattern === 'string' && !new RegExp(rules.pattern).test(value)) {
      out.push({ path, message: `does not match ${rules.pattern}` });
    }
    if (typeof rules.maxLength === 'number' && value.length > rules.maxLength) {
      out.push({ path, message: `longer than ${rules.maxLength} characters` });
    }
    if (rules.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      out.push({ path, message: 'is not an ISO-8601 date-time' });
    }
  }

  if (typeof value === 'number' && typeof rules.minimum === 'number' && value < rules.minimum) {
    out.push({ path, message: `below minimum ${rules.minimum}` });
  }

  if (Array.isArray(value)) {
    if (typeof rules.maxItems === 'number' && value.length > rules.maxItems) {
      out.push({ path, message: `more than ${rules.maxItems} items` });
    }
    if (rules.items !== undefined) {
      value.forEach((entry, index) => walk(entry, rules.items, `${path}/${index}`, out));
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    const properties = (rules.properties ?? {}) as Record<string, unknown>;

    if (Array.isArray(rules.required)) {
      for (const key of rules.required as string[]) {
        if (!(key in object)) out.push({ path: `${path}/${key}`, message: 'is required' });
      }
    }
    if (rules.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!(key in properties)) {
          out.push({ path: `${path}/${key}`, message: 'is not an allowed property' });
        }
      }
    }
    for (const [key, subSchema] of Object.entries(properties)) {
      if (key in object) walk(object[key], subSchema, `${path}/${key}`, out);
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
