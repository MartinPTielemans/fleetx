/**
 * Two machines that join at once each add to t3-fleet.toml: a server to
 * `[defaults.mcp] servers`, an `[[defaults.instructions]]` entry. Line by
 * line those edits collide; as TOML they do not. This merges them, and
 * nothing else: it is for that case only.
 *
 * Both sides, against `base`, may only append to the lists setup writes
 * (`servers`, `servers.add`, `ignore.add`, `[[defaults.instructions]]`),
 * keeping what was there in its order, and add a whole new table (setup's
 * `[relay]`, `[defaults.models]`) the other side does not add differently.
 * Anything else is refused (null): a removal, a changed value, a new key in a
 * table that was there, a reordered list, a server added to a list while the
 * other side leaves it alone (`ignore.add`), two different entries for one
 * instruction file.
 *
 * The result is `ours` with theirs' additions made by TomlEdit, so ours keeps
 * its text and comments, and is checked to be exactly base plus both sides'
 * additions.
 */
import { parse as parseToml } from "smol-toml";

import { addToList, appendEntry, setKey } from "./TomlEdit.ts";

type Table = Record<string, unknown>;

/** List keys setup appends to, in any table, and the lists of tables it appends entries to. */
const LISTS = new Set(["servers", "servers.add", "ignore.add"]);
const ENTRY_LISTS = new Set([JSON.stringify(["defaults", "instructions"])]);

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

/** Appended items by the list's path, and whole new tables by theirs (JSON of the key path). */
interface Additions {
  readonly lists: Map<string, Array<unknown>>;
  readonly tables: Map<string, Table>;
}

/**
 * What `side` appended to `base`'s lists, when that is all it changed.
 * Null for anything else.
 */
export const additions = (base: unknown, side: unknown): Additions | null => {
  const out: Additions = { lists: new Map(), tables: new Map() };
  const walk = (b: unknown, s: unknown, path: ReadonlyArray<string>): boolean => {
    if (same(b, s)) return true;
    const key = path[path.length - 1] ?? "";
    const id = JSON.stringify(path);
    const entries = ENTRY_LISTS.has(id);
    if (Array.isArray(s) && (LISTS.has(key) || entries) && (b === undefined || Array.isArray(b))) {
      const before = (b as Array<unknown> | undefined) ?? [];
      // Kept, in order, with items after it.
      if (before.length > s.length || !before.every((x, i) => same(x, s[i]))) return false;
      const added = s.slice(before.length);
      if (!added.every((x) => (entries ? isTable(x) : typeof x === "string"))) return false;
      out.lists.set(id, added);
      return true;
    }
    if (!isTable(b) || !isTable(s)) return false;
    for (const k of new Set([...Object.keys(b), ...Object.keys(s)])) {
      if (!(k in s)) return false;
      // A whole new table is an addition; a new value in a table that was there only as one of the
      // lists, `[[defaults.instructions]]` included when it is not there yet.
      if (!(k in b) && isTable(s[k])) {
        out.tables.set(JSON.stringify([...path, k]), s[k]);
        continue;
      }
      const list = LISTS.has(k) || ENTRY_LISTS.has(JSON.stringify([...path, k]));
      if (!(k in b) && !(list && Array.isArray(s[k]))) return false;
      if (!walk(b[k], s[k], [...path, k])) return false;
    }
    return true;
  };
  return walk(base, side, []) ? out : null;
};

const at = (table: Table, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>((v, k) => (isTable(v) ? v[k] : undefined), table);

/** `ours` with what `theirs` appended since `base`, or null when that is not all either did. */
export const mergeAdditions = (base: string, ours: string, theirs: string): string | null => {
  const [b, o, t] = [parse(base), parse(ours), parse(theirs)];
  if (b === null || o === null || t === null) return null;
  const mine = additions(b, o);
  const other = additions(b, t);
  if (mine === null || other === null) return null;

  let text = ours;
  for (const [id, table] of other.tables) {
    const path = JSON.parse(id) as Array<string>;
    const have = at(o, path);
    if (have !== undefined) {
      // Both added it: only the same table is one.
      if (!same(have, table)) return null;
      continue;
    }
    const written = writeTable(text, path, table);
    if (written === null) return null;
    text = written;
  }
  for (const [id, added] of other.lists) {
    const path = JSON.parse(id) as Array<string>;
    const current = (at(o, path) as Array<unknown> | undefined) ?? [];
    const fresh = added.filter((x) => !current.some((c) => same(c, x)));
    if (fresh.length === 0) continue;
    if (ENTRY_LISTS.has(id)) {
      // One file, one entry: the same destination added twice differently is a real conflict.
      const dest = (e: unknown) => (isTable(e) ? e["dest"] : undefined);
      if (fresh.some((x) => current.some((c) => dest(c) === dest(x)))) return null;
      for (const entry of fresh) {
        const edit = appendEntry(text, path, entry as Table);
        if ("error" in edit) return null;
        text = edit.text;
      }
    } else {
      const edit = addToList(text, path.slice(0, -1), path[path.length - 1] ?? "", fresh);
      if ("error" in edit) return null;
      text = edit.text;
    }
  }

  // Exactly base plus both sides' additions, and no server both used and left alone.
  const merged = parse(text);
  if (merged === null) return null;
  const all = additions(b, merged);
  if (all === null) return null;
  for (const [id, table] of all.tables)
    if (!same(table, mine.tables.get(id) ?? other.tables.get(id))) return null;
  if (all.tables.size !== new Set([...mine.tables.keys(), ...other.tables.keys()]).size)
    return null;
  for (const [id, added] of all.lists) {
    const expected = [...(mine.lists.get(id) ?? []), ...(other.lists.get(id) ?? [])];
    if (!added.every((x) => expected.some((e) => same(e, x)))) return null;
    if (!expected.every((e) => added.some((x) => same(e, x)))) return null;
  }
  const tables = new Set(
    [...all.lists.keys()].map((id) =>
      JSON.stringify((JSON.parse(id) as Array<string>).slice(0, -1)),
    ),
  );
  for (const table of tables) {
    const path = JSON.parse(table) as Array<string>;
    const list = (key: string) => (at(merged, [...path, key]) as Array<unknown> | undefined) ?? [];
    const used = [...list("servers"), ...list("servers.add")];
    if (list("ignore.add").some((x) => used.includes(x))) return null;
  }
  return text;
};

/** A whole new table written into `text`, key by key; nested tables as their own. */
const writeTable = (text: string, path: ReadonlyArray<string>, table: Table): string | null => {
  let current = text;
  for (const [key, value] of Object.entries(table)) {
    if (isTable(value)) {
      const nested = writeTable(current, [...path, key], value);
      if (nested === null) return null;
      current = nested;
      continue;
    }
    const edit = setKey(current, path, key, value);
    if ("error" in edit) return null;
    current = edit.text;
  }
  return current;
};
