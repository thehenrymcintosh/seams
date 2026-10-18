// Text view: a reviewable spec, one section per module, in the three
// decision categories.

import type { Field, Plan, RepoMethod } from "../ast.ts";
import { check, dependencyGraph } from "../check.ts";
import { walk } from "../walk.ts";
import { erDiagram, systemDiagram } from "./mermaid.ts";
import { typeLabel } from "../types.ts";

export function spec(plan: Plan): string {
  const out: string[] = [];
  const deps = dependencyGraph(plan);
  out.push(`# ${plan.name}`, "");
  out.push("```mermaid", systemDiagram(plan), "```", "");

  const diags = check(plan);
  if (diags.length) {
    out.push("## Check results", "");
    for (const d of diags) out.push(`- **${d.level}** \`${d.at}\`: ${d.message}`);
    out.push("");
  }

  for (const { module: m } of walk(plan)) {
    out.push(`## ${m.name}`, "", m.purpose, "");
    const d = [...(deps.get(m.name) ?? [])];
    out.push(`**Depends on:** ${d.length ? d.join(", ") : "nothing"}`, "");

    if (m.entities.length) {
      out.push("### Data", "", "```mermaid", erDiagram(m.entities), "```", "");
      for (const r of m.repositories) out.push(`- \`${r.name}\`: ${r.methods.map((x) => methodLabel(x)).join(", ")}`);
      out.push("");
    }

    for (const c of m.provides) {
      out.push(`### Contract \`${c.name}\``, "");
      for (const t of c.types) {
        out.push(t.kind === "enum"
          ? `- type **${t.name}** = ${t.values.map((v) => `\`${v}\``).join(" \\| ")}`
          : `- type **${t.name}** { ${fieldList(t.fields)} }`);
      }
      for (const o of c.operations) {
        const sig = `${o.name}(${fieldList(o.input)}) → ${o.output ? typeLabel(o.output) : "void"}`;
        const errs = o.errors.length ? ` · fails with ${o.errors.join(", ")}` : "";
        out.push(`- ${o.mode} \`${sig}\`${errs}`);
      }
      for (const e of c.events) out.push(`- event **${e.name}** { ${fieldList(e.payload)} }`);
      out.push("");
    }

    if (m.uses.length) {
      out.push("### Uses", "");
      for (const u of m.uses) {
        const subs = u.subscribes.length ? `, reacts to ${u.subscribes.join(", ")}` : "";
        out.push(`- \`${u.contract}\`${subs}`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

const fieldList = (fs: Field[]) => fs.map((f) => `${f.name}: ${typeLabel(f.type)}`).join(", ");

function methodLabel(m: RepoMethod): string {
  switch (m.kind) {
    case "get": return "get by key";
    case "find": return `find by ${m.by.join(" + ")}`;
    case "save": return "save";
    case "delete": return "delete";
  }
}
