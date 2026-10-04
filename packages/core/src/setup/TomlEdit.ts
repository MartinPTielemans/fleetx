/**
 * Small edits to TOML files people also edit by hand: add to a list, set a
 * key, append an array-of-tables entry. The rest of the file, comments
 * included, stays as it was. Every edit is checked by parsing the result and
 * reading the value back; an edit this cannot make safely (an inline table,
 * a list over several lines) fails with what to change by hand.
 */

/** The edited text, or why the edit could not be made. */
export type Edit = { readonly text: string } | { readonly error: string };

export const editError = (edit: Edit): string | null => ("error" in edit ? edit.error : null);
import { parse as parseToml } from "smol-toml";

type Table = Record<string, unknown>;

const parse = (text: string): Table | string => {
  try {
    return parseToml(text) as Table;
  } catch (e) {
    return String(e).split("\n")[0] ?? "not valid TOML";
  }
};

const at = (table: Table, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (v, k) =>
      typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Table)[k] : undefined,
    table,
  );

/** A TOML value as it is written on one line. */
export const tomlValue = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(tomlValue).join(", ")}]`
    : typeof value === "object" && value !== null
      ? `{ ${Object.entries(value)
          .map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)
          .join(", ")} }`
      : typeof value === "string"
        ? JSON.stringify(value)
        : String(value);

/** A key as TOML writes it: bare when it can be, quoted otherwise ("servers.add"). */
export const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The lines a key's value spans from `start` (a list over several lines), and
 * the comment after it: what replacing the key replaces, and what it keeps.
 */
const valueExtent = (lines: ReadonlyArray<string>, start: number, end: number) => {
  for (let last = start; last < Math.max(end, start + 1); last++) {
    const text = lines.slice(start, last + 1).join("\n");
    const whole = parse(text);
    if (typeof whole === "string") continue;
    const tail = lines[last] ?? "";
    for (let i = tail.indexOf("#"); i >= 0; i = tail.indexOf("#", i + 1)) {
      const before = parse(lines.slice(start, last).concat(tail.slice(0, i)).join("\n"));
      if (typeof before !== "string" && JSON.stringify(before) === JSON.stringify(whole))
        return { last, comment: tail.slice(i).trimEnd() };
    }
    return { last, comment: "" };
  }
  return { last: start, comment: "" };
};

const header = (path: ReadonlyArray<string>) => `[${path.map(tomlKey).join(".")}]`;

/** Where the table `path` starts and ends in `lines`; null when it has no header of its own. */
const section = (lines: ReadonlyArray<string>, path: ReadonlyArray<string>) => {
  const want = new RegExp(`^\\s*${escape(header(path))}\\s*(#.*)?$`);
  const start = lines.findIndex((l) => want.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end++;
  return { start, end };
};

const check = (text: string, path: ReadonlyArray<string>, want: unknown, what: string): Edit => {
  const parsed = parse(text);
  if (typeof parsed === "string")
    return { error: `${what}: the result would not parse (${parsed})` };
  return JSON.stringify(at(parsed, path)) === JSON.stringify(want)
    ? { text }
    : { error: `${what}: could not write it safely; set it by hand` };
};

/**
 * Set `key` in the table `path` to `value`: replaces a one-line value, adds
 * the key to the table, or adds the table at the end. The new text, or why not.
 */
export const setKey = (
  text: string,
  path: ReadonlyArray<string>,
  key: string,
  value: unknown,
  comment?: string,
): Edit => {
  const what = `${[...path, key].join(".")}`;
  const parsed = parse(text);
  if (typeof parsed === "string") return { error: `${what}: the file does not parse (${parsed})` };
  const lines = text.split("\n");
  const line = `${tomlKey(key)} = ${tomlValue(value)}`;
  const note = comment === undefined ? [] : [`# ${comment}`];
  const found = section(lines, path);
  if (found === null) {
    // A table that only exists through its subtables ([defaults.mcp] without [defaults]) can get its own header.
    const subtable = new RegExp(`^\\s*\\[\\[?${escape(path.map(tomlKey).join("."))}\\.`);
    if (path.length > 0 && at(parsed, path) !== undefined && !lines.some((l) => subtable.test(l)))
      return { error: `${what}: [${path.join(".")}] is written inline; set it by hand` };
    const body = path.length === 0 ? [...note, line] : ["", header(path), ...note, line];
    if (path.length === 0) {
      // Top-level keys go before the first table.
      const first = lines.findIndex((l) => /^\s*\[/.test(l));
      const keyAt = lines.findIndex((l) => new RegExp(`^\\s*${escape(tomlKey(key))}\\s*=`).test(l));
      if (keyAt >= 0 && (first < 0 || keyAt < first)) {
        const { last, comment } = valueExtent(lines, keyAt, first < 0 ? lines.length : first);
        lines.splice(keyAt, last - keyAt + 1, comment === "" ? line : `${line} ${comment}`);
      } else lines.splice(first < 0 ? lines.length : first, 0, ...body, ...(first < 0 ? [] : [""]));
    } else {
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      lines.push(...body, "");
    }
    return check(lines.join("\n"), [...path, key], value, what);
  }
  const keyPattern = new RegExp(`^\\s*${escape(tomlKey(key))}\\s*=`);
  const existing = lines.findIndex(
    (l, i) => i > found.start && i < found.end && keyPattern.test(l),
  );
  if (existing >= 0) {
    const { last, comment } = valueExtent(lines, existing, found.end);
    lines.splice(existing, last - existing + 1, comment === "" ? line : `${line} ${comment}`);
  } else {
    // After the table's last key, before the blank lines that end it.
    let insert = found.end;
    while (insert > found.start + 1 && (lines[insert - 1] ?? "").trim() === "") insert--;
    lines.splice(insert, 0, ...note, line);
  }
  return check(lines.join("\n"), [...path, key], value, what);
};

/** Add `values` to the list `key` in the table `path`, skipping ones it has. */
export const addToList = (
  text: string,
  path: ReadonlyArray<string>,
  key: string,
  values: ReadonlyArray<unknown>,
): Edit => {
  const parsed = parse(text);
  if (typeof parsed === "string") return { error: `${key}: the file does not parse (${parsed})` };
  const current = at(parsed, [...path, key]);
  if (current !== undefined && !Array.isArray(current))
    return { error: `${[...path, key].join(".")} is not a list; add to it by hand` };
  const list = (current as Array<unknown> | undefined) ?? [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const added = values.filter((v) => !list.some((x) => same(x, v)));
  if (added.length === 0) return { text };
  return setKey(text, path, key, [...list, ...added]);
};

/** Append one `[[path]]` entry. */
export const appendEntry = (
  text: string,
  path: ReadonlyArray<string>,
  entry: Readonly<Record<string, unknown>>,
): Edit => {
  const parsed = parse(text);
  if (typeof parsed === "string")
    return { error: `${path.join(".")}: the file does not parse (${parsed})` };
  const before = at(parsed, path);
  if (before !== undefined && !Array.isArray(before))
    return { error: `${path.join(".")} is not a list of tables; add it by hand` };
  const lines = text.replace(/\n+$/, "").split("\n");
  lines.push(
    "",
    `[[${path.map(tomlKey).join(".")}]]`,
    ...Object.entries(entry).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`),
    "",
  );
  const after = lines.join("\n");
  return check(
    after,
    path,
    [...((before as Array<unknown> | undefined) ?? []), entry],
    path.join("."),
  );
};

/** Apply edits in order, stopping at the first that fails. */
export const edits = (text: string, ...steps: ReadonlyArray<(text: string) => Edit>): Edit => {
  let current: Edit = { text };
  for (const step of steps) {
    if ("error" in current) return current;
    current = step(current.text);
  }
  return current;
};
