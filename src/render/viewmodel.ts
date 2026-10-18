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
import { accessPatterns, indexName, RELATIONAL, sqlType } from "../storage.ts";

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
  stores: StoreView[];
  endpoints: EndpointView[];
  ports: PortView[];
  signals: SignalView[];
  tests: TestView[];
  gaps: { module: string; ref?: string; note: string }[];
  modules: ModuleView[];           // sub-modules, drawn inside this card
};

export type Link = { label: string; ref?: string };

export type PortView = {
  id: string; name: string; purpose: string; methods: string[]; injected: boolean;
  adapters: { name: string; env: string }[]; note?: string; sources: string[];
};
export type SignalView = {
  id: string; name: string; type: string; on: Link; fields: string[]; alert?: string; note?: string; sources: string[];
};
export type TestView = {
  id: string; name: string; level: string; covers: Link[]; fakes: Link[]; exists: boolean; note?: string; sources: string[];
};

export type StoreView = { id: string; name: string; engine: string; note?: string; sources: string[]; tables: TableView[] };

// A physical table, with every lookup the module makes on it attached to the
// key or index that serves it. Lookups nothing serves are listed as scans.
export type TableView = {
  id: string;
  entity: string;                  // entity id
  entityName: string;
  table: string;
  relational: boolean;
  columns: { name: string; type: string; nullable: boolean; key: boolean }[];
  indexes: { name: string; on: string[]; unique: boolean; using?: string; serves: string[] }[];
  pk?: string;
  sk?: string;
  gsis: { name: string; pk: string; sk?: string; serves: string[] }[];
  ttl?: string;
  keyServes: string[];
  scans: string[];
};

export type EndpointView = {
  id: string;
  name: string;
  protocol: string;
  method?: string;
  path: string;
  auth: string;
  audience: string;
  note?: string;
  sources: string[];
  calls: { label: string; ref?: string }[];
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
  stored?: { id: string; table: string; store: string; engine: string };
};

export type EdgeView = { from: string; to: string; kind: "call" | "event" | "route"; label?: string };

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
        stored: storedAt(m, path, e.name),
      })),
      stores: storeViews(m, path),
      endpoints: m.endpoints.map((ep) => ({
        id: ids.endpoint(path, ep.name),
        name: ep.name, protocol: ep.protocol, method: ep.method, path: ep.path, auth: ep.auth, audience: ep.audience,
        note: ep.note, sources: sources(ep.sources),
        calls: ep.calls.map((c) => {
          const [cn, op] = c.split(".");
          const o = owner.get(cn);
          return { label: c, ref: o ? ids.operation(o, cn, op) : undefined };
        }),
      })),
      ports: (m.ports ?? []).map((pt) => ({
        id: ids.port(path, pt.name), name: pt.name, purpose: pt.purpose, methods: pt.methods, injected: pt.injected,
        adapters: pt.adapters, note: pt.note, sources: sources(pt.sources),
      })),
      signals: (m.signals ?? []).map((sg) => ({
        id: ids.signal(path, sg.name), name: sg.name, type: sg.type, on: link(sg.on), fields: sg.fields, alert: sg.alert,
        note: sg.note, sources: sources(sg.sources),
      })),
      tests: (m.tests ?? []).map((tc) => ({
        id: ids.test(path, tc.name), name: tc.name, level: tc.level, covers: tc.covers.map(link), fakes: tc.fakes.map(link),
        exists: !!tc.exists, note: tc.note, sources: sources(tc.sources),
      })),
      gaps: (m.gaps ?? []).map((g) => {
        const t = placed.find((p) => p.module.name === g.module);
        return { module: g.module, ref: t ? ids.module(t.path) : undefined, note: g.note };
      }),
      modules: m.modules.map((sub) => moduleView(sub, `${path}/${sub.name}`)),
    };
    // What a signal or test names: an operation or event, an endpoint, a port,
    // an aggregate, or a contract the module uses.
    function link(label: string): Link {
      const [cn, x] = label.split(".");
      const o = owner.get(cn);
      if (o && x) return { label, ref: ids.operation(o, cn, x) };
      if (o) return { label, ref: ids.contract(o, cn) };
      if (m.endpoints.some((e) => e.name === label)) return { label, ref: ids.endpoint(path, label) };
      if (m.ports?.some((p) => p.name === label)) return { label, ref: ids.port(path, label) };
      if (m.aggregates.some((a) => a.name === label)) return { label, ref: ids.aggregate(path, label) };
      return { label };
    }
  };
  const modules = plan.modules.map((m) => moduleView(m, m.name));

  const edges: EdgeView[] = [];
  for (const { module: m, path } of placed) {
    for (const ep of m.endpoints) {
      for (const c of ep.calls) {
        const [cn, op] = c.split(".");
        const o = owner.get(cn);
        if (o) edges.push({ from: ids.endpoint(path, ep.name), to: ids.operation(o, cn, op), kind: "route" });
      }
    }
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

function storedAt(m: Module, path: string, entity: string): EntityView["stored"] {
  for (const st of m.stores) {
    const b = st.holds.find((x) => x.entity === entity);
    if (b) return { id: ids.binding(path, st.name, entity), table: b.table, store: st.name, engine: st.engine };
  }
  return undefined;
}

function storeViews(m: Module, path: string): StoreView[] {
  const access = accessPatterns(m);
  const enums = new Set(m.provides.flatMap((c) => c.types.filter((t) => t.kind === "enum").map((t) => t.name)));
  return m.stores.map((st) => ({
    id: ids.store(path, st.name),
    name: st.name,
    engine: st.engine,
    note: st.note,
    sources: sources(st.sources),
    tables: st.holds.map((b) => {
      const e = m.entities.find((x) => x.name === b.entity);
      const mine = access.filter((a) => a.binding === b);
      const label = (a: (typeof mine)[number]) => `${a.repository.replace(/Repository$/, "")}: ${a.label}`;
      const served = (name: string) => mine.filter((a) => a.servedBy === name).map(label);
      const relational = RELATIONAL.has(st.engine);
      return {
        id: ids.binding(path, st.name, b.entity),
        entity: ids.entity(path, b.entity),
        entityName: b.entity,
        table: b.table,
        relational,
        columns: relational && e ? e.fields.map((f) => {
          const o = b.columns?.find((c) => c.field === f.name);
          const d = sqlType(f.type, enums);
          return { name: o?.column ?? f.name, type: o?.type ?? d.type, nullable: o?.nullable ?? d.nullable, key: e.key.includes(f.name) };
        }) : [],
        indexes: (b.indexes ?? []).map((i) => ({ name: indexName(b, i), on: i.on, unique: !!i.unique, using: i.using, serves: served(indexName(b, i)) })),
        pk: b.pk, sk: b.sk, ttl: b.ttl,
        gsis: (b.gsis ?? []).map((g) => ({ ...g, serves: served(g.name) })),
        keyServes: [...served("primary key"), ...served("table key")],
        scans: mine.filter((a) => !a.servedBy).map(label),
      };
    }),
  }));
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
