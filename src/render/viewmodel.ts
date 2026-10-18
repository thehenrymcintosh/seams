// Everything the page needs, precomputed so the in-page script only draws.
// The view model is derived from the document and never read back.
//
// Types are emitted as tokens, with every reference resolved to the id of the
// type or entity it points at, so the page can connect a use of a type to its
// definition across modules.

import type { Contract, Field, Module, Plan, RepoMethod, TypeExpr } from "../ast.ts";
import { check, dependencyGraph, type Diagnostic } from "../check.ts";
import type { PlanDocument } from "../doc.ts";
import { ids } from "../ids.ts";
import { walk } from "../walk.ts";
import { diff, type Change } from "../views/diff.ts";

export type Tok = { s: string; ref?: string };
export type FieldView = { name: string; type: Tok[] };

export type TreeView = {
  modules: ModuleView[];
  edges: EdgeView[];
  diagnostics: Diagnostic[];
};

export type ModuleView = {
  id: string;
  name: string;
  purpose: string;
  depth: "stub" | "mapped";
  note?: string;
  sources: string[];
  usedBy: string[];                // ids of modules that call this one
  contracts: ContractView[];
  aggregates: AggregateView[];
  entities: EntityView[];
  modules: ModuleView[];           // sub-modules, drawn inside this card
};

export type AggregateView = { id: string; name: string; root: string; members: string[]; invariants: string[] };

export type ContractView = {
  id: string;
  name: string;
  note?: string;
  sources: string[];
  types: TypeView[];
  operations: { id: string; name: string; mode: string; input: FieldView[]; output: Tok[] | null; errors: string[] }[];
  events: { id: string; name: string; payload: FieldView[] }[];
};

export type TypeView = {
  id: string;
  name: string;
  kind: "enum" | "record";
  values?: string[];
  fields?: FieldView[];
};

export type EntityView = {
  id: string;
  name: string;
  note?: string;
  sources: string[];
  fields: (FieldView & { key: boolean })[];
  indexes: string[];
  access: string[];
};

export type EdgeView = { from: string; to: string; kind: "call" | "event"; label?: string };

export type DocumentView = {
  current: TreeView;
  proposed: TreeView | null;
  changes: Change[];
};

export function viewOf(doc: PlanDocument): DocumentView {
  return {
    current: treeView(doc.current),
    proposed: doc.proposed ? treeView(doc.proposed) : null,
    changes: doc.proposed ? diff(doc.current, doc.proposed) : [],
  };
}

function treeView(plan: Plan): TreeView {
  const deps = dependencyGraph(plan);
  const placed = walk(plan);
  const usedBy = new Map<string, string[]>(placed.map((p) => [p.module.name, []]));
  for (const [m, ds] of deps) for (const d of ds) usedBy.get(d)?.push(m);
  const pathOf = new Map(placed.map((p) => [p.module, p.path]));
  const owner = new Map(placed.flatMap((p) => p.module.provides.map((c) => [c.name, p.path] as const)));

  const moduleView = (m: Module, path: string): ModuleView => {
    const resolve = resolver(m, path, owner);
    return {
      id: ids.module(path),
      name: m.name,
      purpose: m.purpose,
      depth: m.depth,
      note: m.note,
      sources: sources(m.sources),
      usedBy: (usedBy.get(m.name) ?? []).map((n) => pathOf.get(placed.find((p) => p.module.name === n)!.module)!),
      contracts: m.provides.map((c) => contractView(path, c, resolve)),
      aggregates: m.aggregates.map((a) => ({
        id: ids.aggregate(path, a.name),
        name: a.name,
        root: ids.entity(path, a.root),
        members: a.members.map((e) => ids.entity(path, e)),
        invariants: a.invariants,
      })),
      entities: m.entities.map((e) => ({
        id: ids.entity(path, e.name),
        name: e.name,
        note: e.note ?? e.doc,
        sources: sources(e.sources),
        fields: e.fields.map((f) => ({ ...fieldView(f, resolve(null)), key: e.key.includes(f.name) })),
        indexes: e.indexes.map((i) => `${i.fields.join(", ")}${i.unique ? " (unique)" : ""}`),
        access: m.repositories.filter((r) => r.entity === e.name).flatMap((r) => r.methods.map(accessLabel)),
      })),
      modules: m.modules.map((sub) => moduleView(sub, `${path}/${sub.name}`)),
    };
  };
  const modules = plan.modules.map((m) => moduleView(m, m.name));

  const edges: EdgeView[] = [];
  for (const { module: m, path } of placed) {
    for (const u of m.uses) {
      const o = owner.get(u.contract);
      if (!o) continue;
      const to = ids.contract(o, u.contract);
      edges.push({ from: ids.module(path), to, kind: "call" });
      if (u.subscribes.length) {
        edges.push({ from: to, to: ids.module(path), kind: "event", label: u.subscribes.join(", ") });
      }
    }
  }
  return { modules, edges, diagnostics: check(plan) };
}

type Resolve = (c: Contract | null) => (name: string) => string | undefined;

// Where a type name points, seen from inside module `m` (and contract `c`).
function resolver(m: Module, path: string, owner: Map<string, string>): Resolve {
  return (c) => (name) => {
    if (name.includes(".")) {
      const [cname, tname] = name.split(".");
      const o = owner.get(cname);
      return o ? ids.type(o, cname, tname) : undefined;
    }
    if (c?.types.some((t) => t.name === name)) return ids.type(path, c.name, name);
    const own = m.provides.find((x) => x.types.some((t) => t.name === name));
    if (own) return ids.type(path, own.name, name);
    if (m.entities.some((e) => e.name === name)) return ids.entity(path, name);
    return undefined;
  };
}

function contractView(path: string, c: Contract, resolve: Resolve): ContractView {
  const r = resolve(c);
  return {
    id: ids.contract(path, c.name),
    name: c.name,
    note: c.note,
    sources: sources(c.sources),
    types: c.types.map((t) => ({
      id: ids.type(path, c.name, t.name),
      name: t.name,
      kind: t.kind,
      values: t.kind === "enum" ? t.values : undefined,
      fields: t.kind === "record" ? t.fields.map((f) => fieldView(f, r)) : undefined,
    })),
    operations: c.operations.map((o) => ({
      id: ids.operation(path, c.name, o.name),
      name: o.name,
      mode: o.mode,
      input: o.input.map((f) => fieldView(f, r)),
      output: o.output ? toks(o.output, r) : null,
      errors: o.errors,
    })),
    events: c.events.map((e) => ({
      id: ids.event(path, c.name, e.name),
      name: e.name,
      payload: e.payload.map((f) => fieldView(f, r)),
    })),
  };
}

const fieldView = (f: Field, r: (name: string) => string | undefined): FieldView =>
  ({ name: f.name, type: toks(f.type, r) });

function toks(t: TypeExpr, r: (name: string) => string | undefined): Tok[] {
  switch (t.kind) {
    case "prim": return [{ s: t.name }];
    case "ref": return [{ s: t.name, ref: r(t.name) }];
    case "list": return [...toks(t.of, r), { s: "[]" }];
    case "optional": return [...toks(t.of, r), { s: "?" }];
  }
}

const sources = (s: Module["sources"]) =>
  (s ?? []).map((x) => `${x.path}${x.line ? `:${x.line}` : ""}${x.symbol ? ` (${x.symbol})` : ""}`);

function accessLabel(m: RepoMethod): string {
  switch (m.kind) {
    case "get": return "get by key";
    case "find": return `find by ${m.by.join(" + ")}`;
    case "save": return "save";
    case "delete": return "delete";
  }
}
