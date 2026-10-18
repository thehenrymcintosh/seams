// Rules that keep modules tidy. Each rule is something a reviewer would
// otherwise have to catch by reading code.

import type { Contract, Entity, Module, Plan, TypeExpr } from "./ast.ts";
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
        if (!isIndexed(target, by)) {
          warn(at, `findBy ${meth.by.join(",")} has no supporting index on ${target.name}`);
        }
      }
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

function isIndexed(e: Entity, by: string[]): boolean {
  const covers = (cols: string[]) => by.every((f, i) => cols[i] === f) || sameSet(cols, by);
  return covers(e.key) || e.indexes.some((i) => covers(i.fields));
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

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
