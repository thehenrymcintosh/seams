// How each access pattern a module declares is served by its storage. The
// checker uses this to find scans, and the page uses it to show which index
// serves which query.

import type { Binding, Entity, Module, PhysicalIndex, Store, TypeExpr } from "./ast.ts";

export type Access = {
  repository: string;
  label: string;                 // "find by Recipient.token"
  entity: string;                // the table the lookup runs on
  by: string[];                  // fields of that table
  store?: Store;
  binding?: Binding;
  servedBy: string | null;       // "primary key", an index name, a GSI name; null = scan
};

export const RELATIONAL = new Set(["postgres", "mysql", "sqlite"]);

export function bindingOf(m: Module, entity: string): { store: Store; binding: Binding } | undefined {
  for (const store of m.stores) {
    const binding = store.holds.find((b) => b.entity === entity);
    if (binding) return { store, binding };
  }
  return undefined;
}

export function accessPatterns(m: Module): Access[] {
  const out: Access[] = [];
  for (const r of m.repositories) {
    const root = m.entities.find((e) => e.name === r.entity);
    if (!root) continue;
    for (const meth of r.methods) {
      if (meth.kind === "save") continue;
      let target: Entity | undefined = root;
      let by = root.key;
      let label = meth.kind === "find" ? `find by ${meth.by.join(" + ")}` : meth.kind === "get" ? "get by key" : "delete by key";
      if (meth.kind === "find") {
        const member = meth.by[0].includes(".") ? meth.by[0].split(".")[0] : "";
        target = member ? m.entities.find((e) => e.name === member) : root;
        by = meth.by.map((f) => f.split(".").pop()!);
        label = `find by ${meth.by.join(" + ")}`;
      }
      if (!target) continue;
      const where = bindingOf(m, target.name);
      out.push({
        repository: r.name, label, entity: target.name, by, ...where,
        servedBy: where ? servedPhysically(target, where.store, where.binding, by) : servedConceptually(target, by),
      });
    }
  }
  return out;
}

const covers = (cols: string[], by: string[]) =>
  by.every((f, i) => cols[i] === f) || (cols.length === by.length && cols.every((c) => by.includes(c)));

function servedConceptually(e: Entity, by: string[]): string | null {
  if (covers(e.key, by)) return "primary key";
  const i = e.indexes.find((x) => covers(x.fields, by));
  return i ? `index (${i.fields.join(", ")})` : null;
}

function servedPhysically(e: Entity, store: Store, b: Binding, by: string[]): string | null {
  if (RELATIONAL.has(store.engine)) {
    if (covers(e.key, by)) return "primary key";
    const field = (on: string) => b.columns?.find((c) => c.column === on)?.field ?? on;
    const i = (b.indexes ?? []).find((x) => covers(x.on.map(field), by));
    return i ? indexName(b, i) : null;
  }
  if (b.pk) {
    const keyed = (pk: string, sk?: string) => {
      const p = templateFields(pk), s = sk ? templateFields(sk) : [];
      return p.every((f) => by.includes(f)) && by.every((f) => p.includes(f) || s.includes(f));
    };
    if (keyed(b.pk, b.sk)) return "table key";
    const g = (b.gsis ?? []).find((x) => keyed(x.pk, x.sk));
    return g ? g.name : null;
  }
  return null;
}

export const indexName = (b: Binding, i: PhysicalIndex) => i.name ?? `${b.table}_${i.on.join("_")}_idx`;

export const templateFields = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);

// The column type a relational store gives a field, unless the binding says otherwise.
export function sqlType(t: TypeExpr, enums: Set<string>): { type: string; nullable: boolean } {
  switch (t.kind) {
    case "optional": return { type: sqlType(t.of, enums).type, nullable: true };
    case "list": return { type: `${sqlType(t.of, enums).type}[]`, nullable: false };
    case "ref": return { type: enums.has(t.name.split(".").pop()!) ? `"${t.name.split(".").pop()}"` : "jsonb", nullable: false };
    case "prim": return {
      type: { string: "text", int: "integer", decimal: "numeric", boolean: "boolean", datetime: "timestamptz", uuid: "uuid" }[t.name],
      nullable: false,
    };
  }
}
