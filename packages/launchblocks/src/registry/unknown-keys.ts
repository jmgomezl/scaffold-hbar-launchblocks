import type { ZodType } from "zod";

import { isPlainObject } from "../flow/refs";

/**
 * Params a step's input schema does not know. zod drops unknown keys
 * silently, so without this a typo such as `nmae`, or `"keys.admin": false`
 * where `"keys": { "admin": false }` was meant, would validate and run with
 * the default instead, creating a token with settings nobody asked for.
 */

export type UnknownKey = { path: string; message: string };

/** The parts of zod's internal definition this walk reads. */
type Def = {
  type: string;
  shape?: Record<string, ZodType>;
  catchall?: ZodType;
  innerType?: ZodType;
  in?: ZodType;
  element?: ZodType;
};

const defOf = (schema: ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** Wrappers that hold one inner schema: `.optional()`, `.default()`, `.prefault()`, and the like. */
const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "nonoptional", "readonly", "catch"]);

export function unknownKeys(schema: ZodType, value: unknown, path = ""): UnknownKey[] {
  const def = defOf(schema);
  if (WRAPPERS.has(def.type) && def.innerType) return unknownKeys(def.innerType, value, path);
  // A transform checks what goes in.
  if (def.type === "pipe" && def.in) return unknownKeys(def.in, value, path);
  if (def.type === "array" && def.element && Array.isArray(value)) {
    const element = def.element;
    return value.flatMap((item: unknown, index) => unknownKeys(element, item, `${path}[${index}]`));
  }
  if (def.type !== "object" || !def.shape || !isPlainObject(value)) return [];
  const shape = def.shape;
  const known = Object.keys(shape);
  // An object that takes any key (`.catchall()`, `.passthrough()`) has none unknown.
  const open = def.catchall !== undefined && defOf(def.catchall).type !== "never";
  return Object.entries(value).flatMap(([key, item]) => {
    const at = path ? `${path}.${key}` : key;
    if (Object.hasOwn(shape, key)) return unknownKeys(shape[key] as ZodType, item, at);
    return open ? [] : [{ path: at, message: `unknown param "${key}"${suggestion(key, known)}` }];
  });
}

/** How to write what was probably meant: nested instead of dotted, or the known key one or two edits away. */
function suggestion(key: string, known: readonly string[]): string {
  const [head, ...rest] = key.split(".");
  if (rest.length && head && known.includes(head)) {
    const nested = rest.reduceRight<string>((inner, part) => `{ "${part}": ${inner} }`, "…");
    return `: nested params are objects, so write "${head}": ${nested}`;
  }
  const close = known.filter(candidate => editDistance(key.toLowerCase(), candidate.toLowerCase()) <= 2);
  return close.length ? `; did you mean "${close[0]}"?` : `; this step takes ${known.map(k => `"${k}"`).join(", ")}`;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] as number;
}
