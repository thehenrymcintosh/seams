// Rules that keep modules tidy. Each rule is something a reviewer would
// otherwise have to catch by reading code.

import type { Contract, Module, Plan, TypeExpr } from "./ast.ts";
import { accessPatterns, RELATIONAL, templateFields } from "./storage.ts";
import { walk } from "./walk.ts";

export type Diagnostic = { level: "error" | "warning"; at: string; message: string };

export type Index = {
  moduleByName: Map<string, Module>;
  contractOwner: Map<string, Module>;          // contract name -> providing module
  contractByName: Map<string, Contract>;
  entityOwner: Map<string, Module>;            // entity name -> owning module
};

export function indexPlan(plan: Plan): Index {
  const ix: Index = {
    moduleByName: new Map(),
    contractOwner: new Map(),
    contractByName: new Map(),
    entityOwner: new Map(),
  };
  for (const { module: m } of walk(plan)) {
    ix.moduleByName.set(m.name, m);
    for (const c of m.provides) {
      ix.contractOwner.set(c.name, m);
      ix.contractByName.set(c.name, c);
    }
    for (const e of m.entities) ix.entityOwner.set(e.name, m);
  }
  return ix;
}

// Module -> modules it depends on, through the contracts it uses.
export function dependencyGraph(plan: Plan, ix = indexPlan(plan)): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>();
  for (const { module: m } of walk(plan)) {
    const deps = new Set<string>();
    for (const u of m.uses) {
      const owner = ix.contractOwner.get(u.contract);
      if (owner && owner !== m) deps.add(owner.name);
    }
    g.set(m.name, deps);
  }
  return g;
}

export function check(plan: Plan): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (at: string, message: string) => out.push({ level: "error", at, message });
  const warn = (at: string, message: string) => out.push({ level: "warning", at, message });
  const ix = indexPlan(plan);

  const tree = walk(plan);
  const all = tree.map((p) => p.module);
  const parentOf = new Map(tree.map((p) => [p.module, p.parent]));
  dupes(all.map((m) => m.name), (n) => err(n, "duplicate module name"));
  dupes(all.flatMap((m) => m.provides.map((c) => c.name)), (n) => err(n, "duplicate contract name"));
  dupes(all.flatMap((m) => m.entities.map((e) => e.name)), (n) => err(n, "entity name used by more than one module"));

  for (const { module: m, ancestors } of tree) {
    const usedContracts = new Set(m.uses.map((u) => u.contract));
    // What this module can see: its own sub-modules, its siblings, and the
    // siblings of each module it sits inside. Never inside someone else.
    const scope = new Set<Module | null>([null, ...ancestors, m]);

    // --- 2. module split: dependencies only go through contracts
    for (const [i, u] of m.uses.entries()) {
      const at = `${m.name} / uses ${u.contract}`;
      if (m.uses.findIndex((x) => x.contract === u.contract) !== i) {
        err(at, `${u.contract} is listed twice; use one entry (subscribe() already implies the dependency)`);
      }
      const owner = ix.contractOwner.get(u.contract);
      if (!owner) { err(at, `no module provides contract "${u.contract}"`); continue; }
      if (owner === m) { err(at, "a module does not need to use its own contract"); continue; }
      const boundary = parentOf.get(owner)!;
      if (!scope.has(boundary)) {
        err(at, `reaches inside ${boundary.name}: ${owner.name} is internal to it; use a contract ${boundary.name} provides instead`);
      }
      const c = ix.contractByName.get(u.contract)!;
      for (const ev of u.subscribes) {
        if (!c.events.some((e) => e.name === ev)) err(at, `contract has no event "${ev}"`);
      }
    }

    // --- 1. data: entities and the repositories that access them
    for (const e of m.entities) {
      const at = `${m.name} / entity ${e.name}`;
      const names = new Set(e.fields.map((f) => f.name));
      dupes(e.fields.map((f) => f.name), (n) => err(at, `duplicate field "${n}"`));
      for (const k of e.key) if (!names.has(k)) err(at, `key field "${k}" does not exist`);
      for (const i of e.indexes) {
        for (const f of i.fields) if (!names.has(f)) err(at, `index field "${f}" does not exist`);
      }
      for (const f of e.fields) {
        resolveInEntity(f.type, m, usedContracts, ix, (msg) => err(`${at}.${f.name}`, msg));
      }
    }

    // --- aggregates: consistency boundaries inside the module
    const inAggregate = new Map<string, string>();
    for (const a of m.aggregates) {
      const at = `${m.name} / aggregate ${a.name}`;
      for (const e of [a.root, ...a.members]) {
        if (!m.entities.some((x) => x.name === e)) err(at, `no entity "${e}" in ${m.name}`);
        if (inAggregate.has(e)) err(at, `${e} is already inside aggregate ${inAggregate.get(e)}`);
        inAggregate.set(e, a.name);
      }
      if (!m.repositories.some((r) => r.entity === a.root)) warn(at, `nothing loads the aggregate: add a repository for ${a.root}`);
    }

    for (const r of m.repositories) {
      const at = `${m.name} / ${r.name}`;
      const agg = m.aggregates.find((a) => a.members.includes(r.entity));
      if (agg) {
        err(at, `${r.entity} is inside the ${agg.name} aggregate; load and save it through ${agg.root}'s repository`);
        continue;
      }
      const local = m.entities.find((e) => e.name === r.entity);
      if (!local) {
        const owner = ix.entityOwner.get(r.entity);
        err(at, owner
          ? `reaches into storage owned by ${owner.name}; go through the ${owner.name} module's contract instead`
          : `no entity "${r.entity}"`);
        continue;
      }
      for (const meth of r.methods) {
        if (meth.kind !== "find") continue;
        // An aggregate root may be found through one of its members: findBy("Recipient.token").
        const member = memberLookup(meth.by);
        if (member === null) { err(at, `findBy ${meth.by.join(",")}: mixes fields of different tables`); continue; }
        let target = local;
        let by = meth.by;
        if (member) {
          const agg = m.aggregates.find((a) => a.root === r.entity);
          const e = m.entities.find((x) => x.name === member);
          if (!agg?.members.includes(member) || !e) {
            err(at, `findBy ${meth.by.join(",")}: ${member} is not a member of an aggregate rooted at ${r.entity}`);
            continue;
          }
          target = e;
          by = meth.by.map((f) => f.slice(member.length + 1));
        }
        const missing = by.filter((f) => !target.fields.some((x) => x.name === f));
        if (missing.length) { err(at, `findBy ${meth.by.join(",")}: no field ${missing.join(", ")} on ${target.name}`); continue; }
      }
    }

    // Every lookup is served by a key or an index, physical when the table is
    // bound to a store. A key-value store cannot query without one.
    for (const a of accessPatterns(m)) {
      if (a.servedBy || (a.label.startsWith("find") && !a.by.every((f) => m.entities.find((e) => e.name === a.entity)?.fields.some((x) => x.name === f)))) continue;
      const at = `${m.name} / ${a.repository}`;
      if (!a.store) warn(at, `${a.label.replace("find by ", "findBy ")} has no supporting index on ${a.entity}`);
      else if (RELATIONAL.has(a.store.engine)) warn(at, `${a.label.replace("find by ", "findBy ")} has no index on table "${a.binding!.table}" in ${a.store.name}: a full table scan`);
      else err(at, `${a.label.replace("find by ", "findBy ")} needs a scan of ${a.store.name}; add a secondary index keyed on ${a.by.join(" + ")}`);
    }

    // --- 1b. stores: each binds this module's own tables
    const bound = new Set<string>();
    for (const st of m.stores) {
      for (const b of st.holds) {
        const at = `${m.name} / store ${st.name} / ${b.table}`;
        const e = m.entities.find((x) => x.name === b.entity);
        if (!e) {
          const owner = ix.entityOwner.get(b.entity);
          err(at, owner ? `stores ${b.entity}, which ${owner.name} owns; a table lives in its owner's store` : `no entity "${b.entity}" in ${m.name}`);
          continue;
        }
        if (bound.has(b.entity)) err(at, `${b.entity} is bound to more than one table`);
        bound.add(b.entity);
        const fields = new Set(e.fields.map((f) => f.name));
        const colToField = new Map((b.columns ?? []).map((c) => [c.column ?? c.field, c.field]));
        for (const c of b.columns ?? []) if (!fields.has(c.field)) err(at, `column for unknown field "${c.field}"`);
        for (const i of b.indexes ?? []) {
          for (const on of i.on) if (!fields.has(colToField.get(on) ?? on)) err(at, `index on unknown column "${on}"`);
        }
        if (RELATIONAL.has(st.engine)) continue;
        if (st.engine === "dynamodb" && !b.pk) { err(at, "a DynamoDB binding needs a partition key template (pk)"); continue; }
        for (const tpl of [b.pk, b.sk, ...(b.gsis ?? []).flatMap((g) => [g.pk, g.sk])]) {
          for (const f of tpl ? templateFields(tpl) : []) if (!fields.has(f)) err(at, `key template "${tpl}" names unknown field "${f}"`);
        }
        if (b.pk && st.engine === "dynamodb") {
          const keyFields = [...templateFields(b.pk), ...(b.sk ? templateFields(b.sk) : [])];
          const missing = e.key.filter((k) => !keyFields.includes(k));
          if (missing.length) err(at, `the table key does not include ${missing.join(", ")}, so two ${e.name} items can collide`);
        }
        if (b.ttl && !fields.has(b.ttl)) err(at, `ttl field "${b.ttl}" does not exist`);
      }
    }

    // --- 3b. endpoints: thin, and only onto contracts the module can reach
    dupes(m.endpoints.map((x) => x.name), (n) => err(`${m.name} / endpoint ${n}`, "duplicate endpoint"));
    for (const ep of m.endpoints) {
      const at = `${m.name} / endpoint ${ep.name}`;
      if (!ep.calls.length) err(at, "calls nothing; an endpoint exposes at least one operation");
      for (const call of ep.calls) {
        const [cname, op] = call.split(".");
        const c = ix.contractByName.get(cname);
        if (!c) { err(at, `unknown contract "${cname}"`); continue; }
        if (!usedContracts.has(cname) && !m.provides.includes(c)) err(at, `calls ${call} without declaring a dependency on ${cname}`);
        if (!c.operations.some((o) => o.name === op)) err(at, `contract ${cname} has no operation "${op}"`);
      }
    }

    // --- 4. wiring: ports are injected, and fakes have something to fake with
    const ports = m.ports ?? [];
    dupes(ports.map((p) => p.name), (n) => err(`${m.name} / port ${n}`, "duplicate port"));
    for (const p of ports) {
      const at = `${m.name} / port ${p.name}`;
      if (usedContracts.has(p.name)) err(at, `is also a contract this module uses; a port is for things outside the domain`);
      if (!p.adapters.some((a) => a.env === "prod")) warn(at, "has no production adapter");
      const faked = (m.tests ?? []).filter((tc) => tc.fakes.includes(p.name)).length;
      const fake = p.adapters.some((a) => a.env === "test");
      const n = `${faked} test${faked === 1 ? "" : "s"}`;
      if (!p.injected && faked) warn(at, `${n} fake it, but the code imports it directly and has no test adapter; inject it and add a fake`);
      else if (!p.injected) warn(at, "is imported directly, so a test can't swap it; pass it in as a dependency");
      else if (faked && !fake) warn(at, `${n} fake it, but it has no test adapter yet`);
    }

    for (const g of m.gaps ?? []) {
      const at = `${m.name} / gap ${g.module}`;
      const target = ix.moduleByName.get(g.module);
      if (!target || target === m) err(at, `no other module named ${g.module}`);
      else if (m.uses.some((u) => ix.contractOwner.get(u.contract) === target)) warn(at, `${g.module} is already a declared dependency; the gap is not needed`);
    }

    // --- 5. observability: signals hang off something real, and leak nothing
    const emitters = new Set<string>([
      ...m.endpoints.map((e) => e.name),
      ...ports.map((p) => p.name),
      ...[...m.provides, ...m.uses.map((u) => ix.contractByName.get(u.contract)).filter((c) => !!c)]
        .flatMap((c) => [...c.operations, ...c.events].map((x) => `${c.name}.${x.name}`)),
    ]);
    dupes((m.signals ?? []).map((x) => x.name), (n) => err(`${m.name} / signal ${n}`, "duplicate signal"));
    for (const sg of m.signals ?? []) {
      const at = `${m.name} / ${sg.type} ${sg.name}`;
      if (!emitters.has(sg.on)) err(at, `"${sg.on}" is not an operation, event, endpoint or port this module has`);
      for (const f of sg.fields) {
        if (/token|secret|password/i.test(f)) warn(at, `field "${f}" may put a secret into telemetry`);
        else if (sg.type === "metric" && /(^id|Id|token|email)$/.test(f)) {
          warn(at, `label "${f}" has one value per record; metrics with high-cardinality labels get expensive`);
        }
      }
      if (sg.alert && sg.type !== "metric") warn(at, "alerts usually need a metric; logs and traces are hard to alert on");
    }

    // --- 6. testing: tests name real things, and fakes are ports or used contracts
    const coverable = new Set<string>([...emitters, ...m.aggregates.map((a) => a.name)]);
    const fakeable = new Set([...ports.map((p) => p.name), ...m.uses.map((u) => u.contract)]);
    for (const tc of m.tests ?? []) {
      const at = `${m.name} / test "${tc.name}"`;
      for (const c of tc.covers) if (!coverable.has(c)) err(at, `covers "${c}", which this module doesn't have`);
      for (const f of tc.fakes) if (!fakeable.has(f)) err(at, `fakes "${f}", which is not a port or a contract this module uses`);
    }

    // --- 3. contracts: types resolve, and storage never leaks through them
    for (const c of m.provides) {
      const at = `${m.name} / contract ${c.name}`;
      dupes(c.types.map((t) => t.name), (n) => err(at, `duplicate type "${n}"`));
      const checkType = (where: string, t: TypeExpr) =>
        resolveInContract(t, c, m, usedContracts, ix, (msg) => err(`${at} / ${where}`, msg));
      for (const td of c.types) {
        if (td.kind === "record") for (const f of td.fields) checkType(`${td.name}.${f.name}`, f.type);
      }
      for (const o of c.operations) {
        for (const f of o.input) checkType(`${o.name}(${f.name})`, f.type);
        if (o.output) checkType(`${o.name} -> output`, o.output);
        if (o.mode === "query" && !o.output) err(`${at} / ${o.name}`, "a query must return something");
      }
      for (const e of c.events) for (const f of e.payload) checkType(`${e.name}.${f.name}`, f.type);
    }

    if (m.depth === "mapped" && m.entities.length && !m.provides.length) {
      warn(m.name, "owns data but provides no contract; nothing else can reach it");
    }
  }

  for (const cycle of findCycles(dependencyGraph(plan, ix))) {
    err(cycle.join(" -> "), "dependency cycle between modules");
  }
  return out;
}

// ---- type resolution -----------------------------------------------------------

function resolveInContract(
  t: TypeExpr, c: Contract, m: Module, used: Set<string>, ix: Index, report: (msg: string) => void,
): void {
  if (t.kind === "list" || t.kind === "optional") return resolveInContract(t.of, c, m, used, ix, report);
  if (t.kind === "prim") return;
  if (c.types.some((d) => d.name === t.name)) return;
  if (resolveQualified(t.name, m, used, ix, report)) return;
  if (ix.entityOwner.has(t.name)) {
    return report(`exposes storage entity "${t.name}"; define a contract type instead`);
  }
  report(`unknown type "${t.name}"`);
}

function resolveInEntity(
  t: TypeExpr, m: Module, used: Set<string>, ix: Index, report: (msg: string) => void,
): void {
  if (t.kind === "list" || t.kind === "optional") return resolveInEntity(t.of, m, used, ix, report);
  if (t.kind === "prim") return;
  if (m.entities.some((e) => e.name === t.name)) return;
  if (m.provides.some((c) => c.types.some((d) => d.name === t.name))) return;
  if (resolveQualified(t.name, m, used, ix, report)) return;
  if (ix.entityOwner.has(t.name)) {
    return report(`references "${t.name}" owned by ${ix.entityOwner.get(t.name)!.name}; store its id instead`);
  }
  report(`unknown type "${t.name}"`);
}

// "Catalog.Money" resolves if the module uses (or provides) the Catalog contract.
function resolveQualified(
  name: string, m: Module, used: Set<string>, ix: Index, report: (msg: string) => void,
): boolean {
  const dot = name.indexOf(".");
  if (dot < 0) return false;
  const [cname, tname] = [name.slice(0, dot), name.slice(dot + 1)];
  const c = ix.contractByName.get(cname);
  if (!c) { report(`unknown contract "${cname}" in "${name}"`); return true; }
  if (!c.types.some((d) => d.name === tname)) { report(`contract ${cname} has no type "${tname}"`); return true; }
  if (!used.has(cname) && !m.provides.includes(c)) {
    report(`"${name}" used without declaring a dependency on contract ${cname}`);
  }
  return true;
}

// ---- helpers -------------------------------------------------------------------

// "" when every field is the root's own, the member's name when every field is
// "Member.field" of one member, null when they mix.
function memberLookup(by: string[]): string | null {
  const owners = new Set(by.map((f) => (f.includes(".") ? f.split(".")[0] : "")));
  return owners.size === 1 ? [...owners][0] : null;
}

function dupes(names: string[], report: (n: string) => void): void {
  const seen = new Set<string>();
  for (const n of names) { if (seen.has(n)) report(n); seen.add(n); }
}

function findCycles(g: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (n: string) => {
    state.set(n, "visiting");
    stack.push(n);
    for (const d of g.get(n) ?? []) {
      if (state.get(d) === "visiting") cycles.push([...stack.slice(stack.indexOf(d)), d]);
      else if (!state.has(d)) visit(d);
    }
    stack.pop();
    state.set(n, "done");
  };
  for (const n of g.keys()) if (!state.has(n)) visit(n);
  return cycles;
}
