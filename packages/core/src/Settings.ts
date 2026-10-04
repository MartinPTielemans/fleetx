/**
 * Merging a node's settings from layers, and remembering where each value
 * came from.
 *
 * Layers, lowest first: fleetx.toml `[defaults]`, each profile the node lists
 * (profiles/<name>.toml, in order), then the node's own file. Tables merge key
 * by key. A list is replaced by a later layer, unless that layer edits it:
 *
 *   ignore = ["a", "b"]          replace
 *   "ignore.add" = ["c"]         append (skipping values already present)
 *   "ignore.remove" = ["a"]      drop
 *
 * so a node can say "everything the workstation profile has, minus one".
 */

export type Value = string | number | boolean | null | ReadonlyArray<Value> | { readonly [key: string]: Value };
export type Table = { readonly [key: string]: Value };

export interface Layer {
  /** Shown in provenance: "defaults", "profile workstation", "node laptop". */
  readonly source: string;
  readonly table: Table;
}

export interface Merged {
  readonly table: Table;
  /** Dotted path → the layer that last set it. */
  readonly provenance: ReadonlyMap<string, string>;
}

const isTable = (v: Value | undefined): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);

const mergeInto = (
  base: Record<string, Value>,
  layer: Table,
  source: string,
  prefix: string,
  provenance: Map<string, string>,
) => {
  for (const [rawKey, value] of Object.entries(layer)) {
    const op = /^(.*)\.(add|remove)$/.exec(rawKey);
    if (op !== null && op[1] !== undefined) {
      const key = op[1];
      const current = Array.isArray(base[key]) ? [...(base[key] as ReadonlyArray<Value>)] : [];
      const items = Array.isArray(value) ? value : [value];
      const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);
      base[key] =
        op[2] === "add"
          ? [...current, ...items.filter((v) => !current.some((c) => same(c, v)))]
          : current.filter((c) => !items.some((v) => same(c, v)));
      provenance.set(prefix + key, `${source} (${op[2]})`);
      continue;
    }
    const existing = base[rawKey];
    if (isTable(value) && isTable(existing)) {
      const copy: Record<string, Value> = { ...existing };
      mergeInto(copy, value, source, `${prefix}${rawKey}.`, provenance);
      base[rawKey] = copy;
    } else {
      base[rawKey] = value;
      markAll(value, source, prefix + rawKey, provenance);
    }
  }
};

const markAll = (value: Value, source: string, path: string, provenance: Map<string, string>) => {
  provenance.set(path, source);
  if (isTable(value)) for (const [k, v] of Object.entries(value)) markAll(v, source, `${path}.${k}`, provenance);
};

export const mergeLayers = (layers: ReadonlyArray<Layer>): Merged => {
  const table: Record<string, Value> = {};
  const provenance = new Map<string, string>();
  for (const layer of layers) mergeInto(table, layer.table, layer.source, "", provenance);
  return { table, provenance };
};

/** Flattened `path = value  # source` lines, for `t3-fleet config show`. */
export const describeMerged = (merged: Merged): Array<{ path: string; value: string; source: string }> => {
  const out: Array<{ path: string; value: string; source: string }> = [];
  const walk = (value: Value, path: string) => {
    if (isTable(value) && Object.keys(value).length > 0) {
      for (const [k, v] of Object.entries(value)) walk(v, path === "" ? k : `${path}.${k}`);
      return;
    }
    out.push({ path, value: JSON.stringify(value), source: merged.provenance.get(path) ?? "?" });
  };
  walk(merged.table, "");
  return out;
};
