/**
 * Two machines that join at once each add to t3-fleet.toml: a server to
 * `[defaults.mcp] servers`, an `[[defaults.instructions]]` entry, a
 * `[relay]`. Line by line those edits collide; as TOML they do not. This
 * merges `theirs` into `ours` when, against `base`, theirs only adds (items
 * to a list, entries to a list of tables, keys and tables) or changes what
 * ours left as it was. Anything else is a real conflict: null.
 *
 * Ours keeps its text and comments; theirs' additions are made with TomlEdit.
 */
import { parse as parseToml } from "smol-toml";

import { addToList, appendEntry, setKey } from "./TomlEdit.ts";

type Table = Record<string, unknown>;

const parse = (text: string): Table | null => {
  try {
    return parseToml(text) as Table;
  } catch {
    return null;
  }
};

const isTable = (v: unknown): v is Table =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The edits theirs made to base, as operations on ours; null when one cannot be carried over. */
const plan = (
  base: unknown,
  ours: unknown,
  theirs: unknown,
  path: ReadonlyArray<string>,
  ops: Array<(text: string) => ReturnType<typeof setKey>>,
): boolean => {
  if (same(base, theirs)) return true;
  if (same(ours, theirs)) return true;
  if (Array.isArray(base) && Array.isArray(theirs) && Array.isArray(ours)) {
    // Theirs only added items: add the same ones to ours.
    if (!base.every((b) => theirs.some((t) => same(t, b)))) return false;
    const added = theirs.filter((t) => !base.some((b) => same(b, t)));
    const key = path[path.length - 1];
    if (key === undefined) return false;
    // A list of tables ([[x]]) grows by entries; a list of values in place.
    if (added.length > 0 && added.every(isTable))
      for (const entry of added) ops.push((t) => appendEntry(t, path, entry as Table));
    else ops.push((t) => addToList(t, path.slice(0, -1), key, added));
    return true;
  }
  // Changed only on their side: take theirs.
  if (same(base, ours) && !isTable(theirs)) {
    const key = path[path.length - 1];
    if (key === undefined) return false;
    ops.push((t) => setKey(t, path.slice(0, -1), key, theirs));
    return true;
  }
  if (
    isTable(theirs) &&
    (base === undefined || isTable(base)) &&
    (ours === undefined || isTable(ours))
  ) {
    const b = (base ?? {}) as Table;
    const o = (ours ?? {}) as Table;
    for (const key of Object.keys(b)) if (!(key in theirs) && !same(b[key], o[key])) return false;
    for (const [key, value] of Object.entries(theirs)) {
      if (!(key in o) && !(key in b)) {
        if (isTable(value)) {
          if (!plan(undefined, undefined, value, [...path, key], ops)) return false;
        } else ops.push((t) => setKey(t, path, key, value));
        continue;
      }
      if (!plan(b[key], o[key], value, [...path, key], ops)) return false;
    }
    return true;
  }
  return false;
};

/** `ours` with what `theirs` added since `base`, or null when they really conflict. */
export const mergeAdditions = (base: string, ours: string, theirs: string): string | null => {
  const [b, o, t] = [parse(base), parse(ours), parse(theirs)];
  if (b === null || o === null || t === null) return null;
  const ops: Array<(text: string) => ReturnType<typeof setKey>> = [];
  if (!plan(b, o, t, [], ops)) return null;
  let text = ours;
  for (const op of ops) {
    const edit = op(text);
    if ("error" in edit) return null;
    text = edit.text;
  }
  return parse(text) === null ? null : text;
};
