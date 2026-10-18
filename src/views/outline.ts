// Agent view: a compact, line-oriented outline of a plan document. This is
// the form an agent reads to validate code against the plan. JSON stays the
// form it edits; this one is for comparing.
//
// Choices, and why:
// - TypeScript-flavoured signatures, because the code being checked is
//   TypeScript and the two can be compared by eye or by grep.
// - Every line that names a node starts with its id in brackets, so a finding
//   ("PlaceOrder now takes a coupon") can point back at the exact node.
// - The proposed tree is written in full and the current one only as the
//   change list, so nothing is stated twice.
// - Rules the code must obey are spelled out at the top, so a check needs
//   nothing beyond this text.

import type { Contract, Field, Module, Plan, TypeExpr } from "../ast.ts";
import type { PlanDocument } from "../doc.ts";
import { ids } from "../ids.ts";
import { diff } from "./diff.ts";

export function outline(doc: PlanDocument): string {
  const target = doc.proposed ?? doc.current;
  const out: string[] = [];
  out.push(`# plan: ${doc.title} (${doc.mode})`);
  out.push(`# intent: ${doc.intent}`);
  out.push(`# describes: ${doc.proposed ? "the system after the change" : "the system as it is"}`);
  out.push("#");
  out.push("# rules the code must follow:");
  out.push("# - a module touches only its own tables; other modules' data is reached through their contract");
  out.push("# - a module calls only contracts listed in its `uses` line");
  out.push("# - contract types never expose a table type");
  out.push("# - each contract operation, event and type exists in code with this shape; `!` lists the errors it can return");
  out.push("# - a sub-module (indented module) is internal to its parent: only the parent and its siblings may use its contract");
  out.push("# - an aggregate is loaded and saved whole through its root; its other tables have no repository of their own,");
  out.push("#   and the invariants listed under it hold whenever it is saved");
  out.push("# - [stub] modules are named only; their insides are not specified");
  out.push("");
  out.push(...planLines(target));

  if (doc.proposed) {
    const changes = diff(doc.current, doc.proposed);
    out.push("", "changes (from current):");
    for (const c of changes) out.push(`  [${c.node}] ${c.tag}: ${c.short ?? c.what}`);
  }
  if (doc.slices.length) {
    out.push("", "phases:");
    doc.slices.forEach((sl, i) => {
      out.push(`  ${i + 1}. ${sl.name}: ${sl.goal}`);
      out.push(`     nodes: ${sl.nodes.join(", ")}`);
      if (sl.notes) out.push(`     note: ${sl.notes}`);
    });
  }
  if (doc.decisions.length) {
    out.push("", "decisions:");
    for (const d of doc.decisions) out.push(`  ${d.node ? `[${d.node}] ` : ""}${d.text} (because: ${d.why})`);
  }
  if (doc.questions.length) {
    out.push("", "open questions:");
    for (const q of doc.questions) out.push(`  ${q.node ? `[${q.node}] ` : ""}${q.text}${q.options ? ` options: ${q.options.join(" | ")}` : ""}`);
  }
  return out.join("\n") + "\n";
}

function planLines(plan: Plan): string[] {
  const out: string[] = [];
  const visit = (m: Module, path: string, pad: string) => {
    out.push(`${pad}module [${ids.module(path)}]${m.depth === "stub" ? " [stub]" : ""} — ${m.purpose}`);
    const p = pad + "  ";
    if (m.sources?.length) out.push(`${p}src: ${m.sources.map((x) => x.path + (x.symbol ? `#${x.symbol}` : "")).join(", ")}`);
    if (m.note) out.push(`${p}note: ${m.note}`);
    const uses = m.uses.map((u) => u.contract + (u.subscribes.length ? ` (on ${u.subscribes.join(", ")})` : ""));
    out.push(`${p}uses: ${uses.length ? uses.join("; ") : "nothing"}`);
    for (const a of m.aggregates) {
      out.push(`${p}aggregate [${ids.aggregate(path, a.name)}] root ${a.root}${a.members.length ? ` + ${a.members.join(", ")}` : ""}`);
      for (const i of a.invariants) out.push(`${p}  invariant: ${i}`);
    }
    for (const e of m.entities) {
      const access = m.repositories.filter((r) => r.entity === e.name)
        .flatMap((r) => r.methods.map((x) => (x.kind === "find" ? `find(${x.by.join("+")})` : x.kind)));
      const idx = e.indexes.map((i) => `${i.unique ? "unique " : ""}(${i.fields.join("+")})`);
      out.push(`${p}table [${ids.entity(path, e.name)}] { ${fields(e.fields)} } key(${e.key.join("+")})` +
        `${idx.length ? ` index ${idx.join(" ")}` : ""}${access.length ? ` access ${access.join(" ")}` : ""}`);
    }
    for (const c of m.provides) out.push(...contractLines(m, path, c, p));
    for (const sub of m.modules) visit(sub, `${path}/${sub.name}`, p);
  };
  for (const m of plan.modules) visit(m, m.name, "");
  return out;
}

function contractLines(m: Module, path: string, c: Contract, p: string): string[] {
  const out = [`${p}contract [${ids.contract(path, c.name)}]${m.depth === "stub" ? " (not mapped)" : ""}`];
  for (const t of c.types) {
    const body = t.kind === "enum" ? t.values.map((v) => JSON.stringify(v)).join(" | ") : `{ ${fields(t.fields)} }`;
    out.push(`${p}  type [${ids.type(path, c.name, t.name)}] = ${body}`);
  }
  for (const o of c.operations) {
    const errs = o.errors.length ? ` ! ${o.errors.join(" | ")}` : "";
    out.push(`${p}  ${o.mode === "command" ? "cmd" : "query"} [${ids.operation(path, c.name, o.name)}] (${fields(o.input)}) => ${o.output ? ts(o.output) : "void"}${errs}`);
  }
  for (const e of c.events) out.push(`${p}  event [${ids.event(path, c.name, e.name)}] { ${fields(e.payload)} }`);
  return out;
}

const fields = (fs: Field[]) => fs.map((f) => `${f.name}: ${ts(f.type)}`).join(", ");

function ts(t: TypeExpr): string {
  switch (t.kind) {
    case "prim": return t.name;
    case "ref": return t.name;
    case "list": return `${ts(t.of)}[]`;
    case "optional": return `${ts(t.of)} | null`;
  }
}
