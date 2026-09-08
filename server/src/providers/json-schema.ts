/**
 * One schema literal, two wire dialects.
 *
 * Anthropic takes a JSON Schema more or less as written. OpenAI-compatible
 * strict mode — which Groq implements — accepts a deliberately small subset and
 * REJECTS the request outright if anything outside it appears. So the schemas
 * in each feature's `schema.ts` stay as they are, and this converts on the way out.
 *
 * Converting rather than maintaining two copies is the whole point: the schema
 * is hashed into `promptVersion`, so a second copy would be a second hash and a
 * silent way for the two providers to be prompted differently while reporting
 * the same version.
 *
 * ## What is lost, and why it does not matter here
 *
 * Strict mode drops every bound: `minItems`, `maxItems`, `minimum`, `maximum`,
 * `maxLength`. That sounds alarming and is not, because this codebase already
 * re-enforces every one of them in code — `mcq/validate.ts` checks the option
 * count and the answer index, `ca/pipeline.ts` drops an item with no evidence
 * and truncates an over-long note, `drills/pipeline.ts` and
 * `interview/pipeline.ts` cap their text fields. The schema was the belt; the
 * validators are the braces, and the braces were always the load-bearing half.
 *
 * The audit that established this is worth repeating if a schema changes: for
 * every keyword `stripped` reports, find the code that re-enforces it. If there
 * is none, the constraint is genuinely lost and belongs in a validator before
 * this dialect ships.
 *
 * ## What must NOT be lost
 *
 * `required` and `additionalProperties: false` are not optional in strict mode —
 * they are what makes it strict, and a schema missing either is rejected by the
 * provider rather than quietly relaxed. `assertStrictInvariants` checks them at
 * BOOT, for every schema, regardless of which provider is configured, so a
 * schema edit that breaks compatibility fails on a developer's machine rather
 * than the first time someone sets `PROVIDER_BULK=groq`.
 */

/**
 * Keywords strict mode rejects.
 *
 * Ordered as: size bounds, numeric bounds, string bounds, then the annotations.
 * `format` and `pattern` are included because strict mode's support for them is
 * inconsistent across providers and a rejected request costs a whole batch,
 * where losing the keyword costs nothing this codebase relies on.
 */
const STRIPPED_KEYWORDS: readonly string[] = [
  'minItems',
  'maxItems',
  'uniqueItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minProperties',
  'maxProperties',
  'default',
  'examples',
];

export interface StrictSubsetResult {
  schema: Record<string, unknown>;
  /**
   * Every keyword removed, as `path:keyword`, sorted.
   *
   * Returned rather than discarded so the boot log can print exactly what each
   * schema lost. An operator should be able to read this list against the
   * validators that re-enforce them — see the header.
   */
  stripped: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A deep copy with the unsupported keywords removed.
 *
 * Never mutates its input. The schemas are module-level constants shared with
 * the Anthropic path and hashed into `promptVersion`; mutating one in place
 * would change what the other provider is sent and what the hash describes,
 * from a function whose name says it returns a new thing.
 */
export function toStrictSubset(schema: Record<string, unknown>): StrictSubsetResult {
  const stripped: string[] = [];

  function walk(node: unknown, path: string): unknown {
    if (Array.isArray(node)) return node.map((entry, index) => walk(entry, `${path}[${index}]`));
    if (!isPlainObject(node)) return node;

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (STRIPPED_KEYWORDS.includes(key)) {
        stripped.push(`${path === '' ? '$' : path}:${key}`);
        continue;
      }
      out[key] = walk(value, path === '' ? key : `${path}.${key}`);
    }
    return out;
  }

  return {
    schema: walk(schema, '') as Record<string, unknown>,
    stripped: stripped.sort(),
  };
}

/**
 * Throws unless the schema satisfies strict mode's structural requirements.
 *
 * Run at boot over every schema, whichever provider is configured, so this is a
 * ratchet rather than a migration: all five current schemas already pass, and
 * an edit that breaks one fails immediately instead of at the first Groq call.
 *
 * The message names the path, because "schema is invalid" on a document with
 * forty nested properties is a message that costs an hour.
 */
export function assertStrictInvariants(schema: Record<string, unknown>, label: string): void {
  const problems: string[] = [];

  function check(node: unknown, path: string): void {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => check(entry, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) return;

    const type = node.type;
    const isObjectNode =
      type === 'object' || (Array.isArray(type) && (type as unknown[]).includes('object'));

    if (isObjectNode) {
      const properties = isPlainObject(node.properties) ? node.properties : null;

      if (node.additionalProperties !== false) {
        problems.push(`${path || '$'} is an object without additionalProperties: false`);
      }

      // Strict mode requires EVERY property to be listed in `required`. A field
      // that is genuinely optional is expressed as a nullable type instead —
      // which is what the existing schemas already do.
      if (properties !== null) {
        const required = Array.isArray(node.required) ? (node.required as unknown[]) : [];
        for (const name of Object.keys(properties)) {
          if (!required.includes(name)) {
            problems.push(`${path || '$'}.${name} is not listed in required`);
          }
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      check(value, path === '' ? key : `${path}.${key}`);
    }
  }

  if (!isPlainObject(schema) || schema.type !== 'object') {
    throw new Error(`Schema ${label} must have an object at its root for strict mode.`);
  }

  check(schema, '');

  if (problems.length > 0) {
    throw new Error(
      `Schema ${label} is not valid for OpenAI-compatible strict mode:\n  - ${problems.join('\n  - ')}`,
    );
  }
}
