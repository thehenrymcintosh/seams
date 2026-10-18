// Change view: a planned change is a diff between two plans. Each line is
// tagged with what it costs, so review starts from consequences rather than
// from lines of code.
//
//   breaking   a consumer of a contract has to change
//   migration  stored data has to change
//   additive   nothing existing has to change

import type { Contract, Field, Module, Plan, TypeDef } from "../ast.ts";
import { typeLabel } from "../types.ts";
import { ids } from "../ids.ts";
import { walk } from "../walk.ts";

export type Tag = "breaking" | "migration" | "additive" | "internal";
// `what` reads on its own (for reports); `short` reads next to the node it is
// attached to, without repeating the node's name.
export type Change = { module: string; tag: Tag; what: string; short?: string; contract?: string; node: string };

export function diff(before: Plan, after: Plan): Change[] {
  const out: Change[] = [];
  const push = (module: string, tag: Tag, what: string, contract?: string, node?: string, short?: string) =>
    out.push({ module, tag, what, short, contract, node: node ?? (contract ? ids.contract(module, contract) : ids.module(module)) });

  // Modules nest, so changes are keyed by module path ("Payments/Gateway").
  const modules = (as: Module[], bs: Module[], prefix: string) => {
    const at = (m: Module) => (prefix ? `${prefix}/${m.name}` : m.name);
    const { added, removed, both } = match(as, bs);
    for (const m of added) push(at(m), "additive", `new module: ${m.purpose}`, undefined, undefined, "new module");
    for (const m of removed) {
      push(at(m), "breaking", "module removed");
      for (const c of m.provides) push(at(m), "breaking", `contract ${c.name} removed`, c.name);
    }

    for (const [a, b] of both) {
      const mod = at(b);
      modules(a.modules, b.modules, mod);

      // 1. data
      const ents = match(a.entities, b.entities);
      for (const e of ents.added) push(mod, "migration", `new table ${e.name}`, undefined, ids.entity(mod, e.name));
      for (const e of ents.removed) push(mod, "migration", `drop table ${e.name}`, undefined, ids.entity(mod, e.name));
      for (const [ea, eb] of ents.both) {
        const eid = ids.entity(mod, eb.name);
        const fs = match(ea.fields, eb.fields);
        for (const f of fs.added) {
          const optional = f.type.kind === "optional";
          const short = `add column ${f.name}: ${typeLabel(f.type)}${optional ? "" : " (needs a backfill or default)"}`;
          push(mod, "migration", `${eb.name}: ${short}`, undefined, eid, short);
        }
        for (const f of fs.removed) push(mod, "migration", `${eb.name}: drop column ${f.name}`, undefined, eid, `drop column ${f.name}`);
        for (const [fa, fb] of fs.both) {
          if (typeLabel(fa.type) !== typeLabel(fb.type)) {
            push(mod, "migration", `${eb.name}.${fb.name}: ${typeLabel(fa.type)} → ${typeLabel(fb.type)}`, undefined, eid, `${fb.name}: ${typeLabel(fa.type)} → ${typeLabel(fb.type)}`);
          }
        }
        if (ea.key.join() !== eb.key.join()) push(mod, "migration", `${eb.name}: key ${ea.key.join(", ")} → ${eb.key.join(", ")}`, undefined, eid, `key ${ea.key.join(", ")} → ${eb.key.join(", ")}`);
        const ia = new Set(ea.indexes.map((i) => i.fields.join(","))), ib = new Set(eb.indexes.map((i) => i.fields.join(",")));
        for (const i of ib) if (!ia.has(i)) push(mod, "migration", `${eb.name}: add index (${i})`, undefined, eid, `add index (${i})`);
        for (const i of ia) if (!ib.has(i)) push(mod, "migration", `${eb.name}: drop index (${i})`, undefined, eid, `drop index (${i})`);
      }
      const aggs = match(a.aggregates, b.aggregates);
      for (const g of aggs.added) push(mod, "internal", `new aggregate ${g.name}: ${[g.root, ...g.members].join(", ")}`, undefined, ids.aggregate(mod, g.name), "new aggregate");
      for (const g of aggs.removed) push(mod, "internal", `aggregate ${g.name} dissolved`);
      for (const [ga, gb] of aggs.both) {
        const gid = ids.aggregate(mod, gb.name);
        if (ga.root !== gb.root) push(mod, "internal", `${gb.name}: root is now ${gb.root}`, undefined, gid, `root is now ${gb.root}`);
        for (const e of gb.members) if (!ga.members.includes(e)) push(mod, "internal", `${gb.name}: now includes ${e}`, undefined, gid, `now includes ${e}`);
        for (const e of ga.members) if (!gb.members.includes(e)) push(mod, "internal", `${gb.name}: no longer includes ${e}`, undefined, gid, `no longer includes ${e}`);
        for (const i of gb.invariants) if (!ga.invariants.includes(i)) push(mod, "internal", `${gb.name}: new invariant: ${i}`, undefined, gid, `new invariant: ${i}`);
      }
      const repos = match(a.repositories, b.repositories);
      for (const r of repos.added) push(mod, "internal", `new ${r.name}`);
      for (const [ra, rb] of repos.both) {
        const sig = (x: typeof ra.methods[number]) => (x.kind === "find" ? `findBy ${x.by.join("+")}` : x.kind);
        const sa = new Set(ra.methods.map(sig));
        for (const s of rb.methods.map(sig)) if (!sa.has(s)) push(mod, "internal", `${rb.name}: new access path ${s}`);
      }

      // 1b. physical storage
      const stores = match(a.stores, b.stores);
      for (const st of stores.added) push(mod, "migration", `new ${st.engine} store ${st.name}`, undefined, ids.store(mod, st.name), `new ${st.engine} store`);
      for (const st of stores.removed) push(mod, "migration", `store ${st.name} removed`, undefined, ids.module(mod), `store ${st.name} removed`);
      for (const [sa, sb] of stores.both) {
        const sid = ids.store(mod, sb.name);
        if (sa.engine !== sb.engine) push(mod, "migration", `${sb.name}: moves from ${sa.engine} to ${sb.engine}`, undefined, sid, `moves from ${sa.engine} to ${sb.engine}`);
        const bs = match(sa.holds.map((x) => ({ ...x, name: x.entity })), sb.holds.map((x) => ({ ...x, name: x.entity })));
        for (const x of bs.added) push(mod, "migration", `${sb.name}: new table ${x.table}`, undefined, ids.binding(mod, sb.name, x.entity), `new table ${x.table}`);
        for (const x of bs.removed) push(mod, "migration", `${sb.name}: drop table ${x.table}`, undefined, sid, `drop table ${x.table}`);
        for (const [xa, xb] of bs.both) {
          const bid = ids.binding(mod, sb.name, xb.entity);
          const at = (short: string) => push(mod, "migration", `${xb.table}: ${short}`, undefined, bid, short);
          if (xa.table !== xb.table) at(`renamed from ${xa.table}`);
          const ia = new Set(xa.indexes.map((i) => i.on.join(", "))), ib = new Set(xb.indexes.map((i) => i.on.join(", ")));
          for (const i of ib) if (!ia.has(i)) at(`add index (${i})`);
          for (const i of ia) if (!ib.has(i)) at(`drop index (${i})`);
          if (xa.pk !== xb.pk || xa.sk !== xb.sk) at(`re-key every item: ${xb.pk}${xb.sk ? ` / ${xb.sk}` : ""}`);
          const ga = new Set(xa.gsis.map((g) => g.name));
          for (const g of xb.gsis) if (!ga.has(g.name)) at(`new index ${g.name} (backfills existing items)`);
          for (const g of xa.gsis) if (!xb.gsis.some((x) => x.name === g.name)) at(`drop index ${g.name}`);
          for (const c of xb.columns) {
            const prev = xa.columns.find((y) => y.field === c.field);
            if (prev && prev.type !== c.type && c.type) at(`${c.column ?? c.field}: ${prev.type ?? "default"} → ${c.type}`);
            if (prev && (prev.column ?? prev.field) !== (c.column ?? c.field)) at(`rename column ${prev.column ?? prev.field} → ${c.column ?? c.field}`);
          }
        }
      }

      // 3b. endpoints: removing or tightening one breaks its callers
      const eps = match(a.endpoints, b.endpoints);
      for (const e of eps.added) push(mod, "additive", `new endpoint ${e.name}`, undefined, ids.endpoint(mod, e.name), "new endpoint");
      for (const e of eps.removed) push(mod, "breaking", `endpoint ${e.name} removed`, undefined, ids.module(mod), `endpoint ${e.name} removed`);
      for (const [ea, eb] of eps.both) {
        const eid = ids.endpoint(mod, eb.name);
        const where = (e: typeof ea) => `${e.method ? `${e.method} ` : ""}${e.path}`;
        if (where(ea) !== where(eb)) push(mod, "breaking", `${eb.name}: moves from ${where(ea)} to ${where(eb)}`, undefined, eid, `moves from ${where(ea)} to ${where(eb)}`);
        const reach = { public: 2, app: 1, internal: 0 };
        if (ea.audience !== eb.audience) {
          const tag: Tag = reach[eb.audience] < reach[ea.audience] ? "breaking" : "additive";
          push(mod, tag, `${eb.name}: audience ${ea.audience} → ${eb.audience}`, undefined, eid, `audience ${ea.audience} → ${eb.audience}`);
        }
        if (ea.auth !== eb.auth) push(mod, "breaking", `${eb.name}: auth ${ea.auth} → ${eb.auth}`, undefined, eid, `auth ${ea.auth} → ${eb.auth}`);
        if (ea.calls.join() !== eb.calls.join()) push(mod, "internal", `${eb.name}: now calls ${eb.calls.join(", ")}`, undefined, eid, `now calls ${eb.calls.join(", ")}`);
      }

      // 4-6. wiring, signals, tests: nothing outside the module changes,
      // except a dashboard or alert that reads a metric that goes away
      const ps = match(a.ports, b.ports);
      for (const p of ps.added) push(mod, "internal", `new port ${p.name}: ${p.purpose}`, undefined, ids.port(mod, p.name), "new port");
      for (const p of ps.removed) push(mod, "internal", `port ${p.name} removed`);
      for (const [pa, pb] of ps.both) {
        const pid = ids.port(mod, pb.name);
        for (const x of pb.adapters) if (!pa.adapters.some((y) => y.name === x.name)) push(mod, "internal", `${pb.name}: new ${x.env} adapter ${x.name}`, undefined, pid, `new ${x.env} adapter ${x.name}`);
        if (!pa.injected && pb.injected) push(mod, "internal", `${pb.name}: now injected`, undefined, pid, "now injected");
      }
      const ss = match(a.signals, b.signals);
      for (const x of ss.added) push(mod, "additive", `new ${x.type} ${x.name}`, undefined, ids.signal(mod, x.name), `new ${x.type}`);
      for (const x of ss.removed) {
        const read = x.type === "metric" || x.alert;
        push(mod, read ? "breaking" : "internal", `${x.type} ${x.name} removed${read ? " (dashboards and alerts that read it break)" : ""}`);
      }
      for (const [xa, xb] of ss.both) {
        const gone = xa.fields.filter((f) => !xb.fields.includes(f));
        if (gone.length && xb.type === "metric") push(mod, "breaking", `${xb.name}: drops label ${gone.join(", ")}`, undefined, ids.signal(mod, xb.name), `drops label ${gone.join(", ")}`);
        if (xa.alert !== xb.alert) push(mod, "internal", `${xb.name}: alert ${xb.alert ?? "removed"}`, undefined, ids.signal(mod, xb.name), `alert ${xb.alert ?? "removed"}`);
      }
      const ts = match(a.tests, b.tests);
      for (const x of ts.added) push(mod, "internal", `new ${x.level} test: ${x.name}`, undefined, ids.test(mod, x.name), `new ${x.level} test`);
      for (const x of ts.removed) push(mod, "internal", `${x.level} test removed: ${x.name}`);

      for (const g of b.gaps) if (!a.gaps.some((x) => x.module === g.module)) push(mod, "internal", `new gap: the code reaches ${g.module} outside the model`);
      for (const g of a.gaps) if (!b.gaps.some((x) => x.module === g.module)) push(mod, "internal", `closes the gap with ${g.module}`);

      // 2. module split
      const ua = new Set(a.uses.map((u) => u.contract)), ub = new Set(b.uses.map((u) => u.contract));
      for (const u of b.uses) {
        if (!ua.has(u.contract)) push(mod, "internal", `now depends on ${u.contract}`);
        const prev = a.uses.find((x) => x.contract === u.contract)?.subscribes ?? [];
        for (const ev of u.subscribes) if (!prev.includes(ev)) push(mod, "internal", `now reacts to ${u.contract}.${ev}`);
      }
      for (const u of ua) if (!ub.has(u)) push(mod, "internal", `no longer depends on ${u}`);

      // 3. contracts
      const cs = match(a.provides, b.provides);
      for (const c of cs.added) push(mod, "additive", `new contract ${c.name}`);
      for (const c of cs.removed) push(mod, "breaking", `contract ${c.name} removed`, c.name);
      for (const [ca, cb] of cs.both) {
        diffContract(ca, cb, (tag, what, sub, short) =>
          push(mod, tag, `${cb.name}: ${what}`, cb.name, sub ? `${ids.contract(mod, cb.name)}/${sub}` : undefined, short));
      }

      // Across categories: an enum value dropped from a contract type that an
      // entity stores means existing rows hold a value that no longer exists.
      for (const [ca, cb] of cs.both) {
        for (const ta of ca.types) {
          const tb = cb.types.find((x) => x.name === ta.name);
          if (ta.kind !== "enum" || tb?.kind !== "enum") continue;
          const gone = ta.values.filter((v) => !tb.values.includes(v));
          const added = tb.values.filter((v) => !ta.values.includes(v));
          if (!gone.length && !added.length) continue;
          // Added values only matter to storage when the column is a database
          // enum. A plan types a free-text column as string, so a field that
          // references the enum is taken to be one.
          for (const e of b.entities) for (const f of e.fields) {
            if (typeLabel(f.type).replace(/[?\[\]]/g, "") !== ta.name) continue;
            if (gone.length) {
              const short = `${f.name}: rows with ${gone.map((v) => `"${v}"`).join(", ")} must be mapped to a new ${ta.name}`;
              push(mod, "migration", `${e.name}.${short}`, undefined, ids.entity(mod, e.name), short);
            }
            if (added.length) {
              const short = `${f.name}: database enum gains ${added.map((v) => `"${v}"`).join(", ")}`;
              push(mod, "migration", `${e.name}.${short}`, undefined, ids.entity(mod, e.name), short);
            }
          }
        }
      }
    }
  };
  modules(before.modules, after.modules, "");
  return out;
}

// `sub` is the path below the contract that a change belongs to (an
// operation, event or type), so it can be shown where it happens.
type ContractPush = (tag: Tag, what: string, sub?: string, short?: string) => void;

function diffContract(a: Contract, b: Contract, push: ContractPush): void {
  const ts = match(a.types, b.types);
  for (const t of ts.added) push("additive", `new type ${t.name}`, `type/${t.name}`, "new type");
  for (const t of ts.removed) push("breaking", `type ${t.name} removed`);
  for (const [ta, tb] of ts.both) diffType(ta, tb, (tag, what, short) => push(tag, what, `type/${tb.name}`, short));

  const ops = match(a.operations, b.operations);
  for (const o of ops.added) push("additive", `new ${o.mode} ${o.name}`, o.name, `new ${o.mode}`);
  for (const o of ops.removed) push("breaking", `${o.mode} ${o.name} removed`);
  for (const [oa, ob] of ops.both) {
    const at = (tag: Tag, short: string) => push(tag, `${ob.name}: ${short}`, ob.name, short);
    const ins = match(oa.input, ob.input);
    for (const f of ins.added) {
      at(f.type.kind === "optional" ? "additive" : "breaking", `new input ${f.name}: ${typeLabel(f.type)}`);
    }
    for (const f of ins.removed) at("breaking", `input ${f.name} removed`);
    for (const [fa, fb] of ins.both) {
      if (typeLabel(fa.type) !== typeLabel(fb.type)) at("breaking", `input ${fb.name} is now ${typeLabel(fb.type)}`);
    }
    const oa_ = oa.output ? typeLabel(oa.output) : "void", ob_ = ob.output ? typeLabel(ob.output) : "void";
    if (oa_ !== ob_) at("breaking", `returns ${ob_} instead of ${oa_}`);
    for (const e of ob.errors) if (!oa.errors.includes(e)) at("breaking", `can now fail with ${e}`);
  }

  const evs = match(a.events, b.events);
  for (const e of evs.added) push("additive", `new event ${e.name}`, e.name, "new event");
  for (const e of evs.removed) push("breaking", `event ${e.name} removed`);
  for (const [ea, eb] of evs.both) {
    const ps = match(ea.payload, eb.payload);
    for (const f of ps.added) push("additive", `${eb.name}: new field ${f.name}`, eb.name, `new field ${f.name}`);
    for (const f of ps.removed) push("breaking", `${eb.name}: field ${f.name} removed`, eb.name, `field ${f.name} removed`);
    for (const [fa, fb] of ps.both) {
      const was = typeLabel(fa.type), now = typeLabel(fb.type);
      if (was !== now) push("breaking", `${eb.name}: field ${fb.name} is now ${now}`, eb.name, `field ${fb.name}: ${was} → ${now}`);
    }
  }
}

function diffType(a: TypeDef, b: TypeDef, push: (tag: Tag, what: string, short: string) => void): void {
  const at = (tag: Tag, short: string) => push(tag, `${b.name} ${short}`, short);
  if (a.kind === "enum" && b.kind === "enum") {
    // Widening an enum breaks anyone who switches over it exhaustively.
    for (const v of b.values) if (!a.values.includes(v)) at("breaking", `gains value "${v}" (exhaustive switches must handle it)`);
    for (const v of a.values) if (!b.values.includes(v)) at("breaking", `loses value "${v}"`);
  } else if (a.kind === "record" && b.kind === "record") {
    const fs = match(a.fields as Field[], b.fields as Field[]);
    for (const f of fs.added) at("additive", `gains field ${f.name}`);
    for (const f of fs.removed) at("breaking", `loses field ${f.name}`);
    for (const [fa, fb] of fs.both) {
      const was = typeLabel(fa.type), now = typeLabel(fb.type);
      if (was !== now) at("breaking", `field ${fb.name}: ${was} → ${now}`);
    }
  } else {
    at("breaking", "changed shape");
  }
}

function match<T extends { name: string }>(a: T[], b: T[]) {
  return {
    added: b.filter((x) => !a.some((y) => y.name === x.name)),
    removed: a.filter((x) => !b.some((y) => y.name === x.name)),
    both: a.flatMap((x) => {
      const y = b.find((z) => z.name === x.name);
      return y ? [[x, y] as [T, T]] : [];
    }),
  };
}

// Markdown review: who has to act, then what changed per module.
export function diffReport(before: Plan, after: Plan): string {
  const changes = diff(before, after);
  const lines = [`# Planned change: ${before.name} → ${after.name}`, ""];

  const breakingContracts = new Set(
    changes.filter((c) => c.tag === "breaking" && c.contract).map((c) => c.contract!),
  );
  const affected = walk(after).map((p) => p.module).filter((m: Module) => m.uses.some((u) => breakingContracts.has(u.contract)));
  const count = (t: Tag) => changes.filter((c) => c.tag === t).length;
  lines.push(`${count("breaking")} breaking, ${count("migration")} migration, ${count("additive")} additive, ${count("internal")} internal.`, "");
  if (affected.length) {
    lines.push(`**Consumers that must change:** ${affected.map((m) => {
      const via = m.uses.filter((u) => breakingContracts.has(u.contract)).map((u) => u.contract);
      return `${m.name} (via ${via.join(", ")})`;
    }).join("; ")}`, "");
  }

  const order: Tag[] = ["breaking", "migration", "additive", "internal"];
  for (const mod of [...new Set(changes.map((c) => c.module))]) {
    lines.push(`## ${mod}`, "");
    for (const tag of order) {
      for (const c of changes.filter((x) => x.module === mod && x.tag === tag)) lines.push(`- \`${tag}\` ${c.what}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
