// Diagram view: modules as boxes holding the data they own and the contracts
// they provide. Arrows are the only cross-module edges the plan allows.

import type { Entity, Plan } from "../ast.ts";
import { indexPlan } from "../check.ts";
import { walk } from "../walk.ts";
import { refName, typeLabel } from "../types.ts";

export function systemDiagram(plan: Plan): string {
  const ix = indexPlan(plan);
  const lines = ["flowchart LR"];
  for (const { module: m } of walk(plan)) {
    lines.push(`  subgraph ${m.name}["${m.name}"]`);
    lines.push(`    direction TB`);
    for (const c of m.provides) lines.push(`    ${c.name}_c{{"${c.name} contract"}}`);
    for (const e of m.entities) lines.push(`    ${m.name}_${e.name}[("${e.name}")]`);
    lines.push(`  end`);
  }
  for (const { module: m } of walk(plan)) {
    for (const u of m.uses) {
      if (!ix.contractOwner.has(u.contract)) continue;
      lines.push(`  ${m.name} -->|calls| ${u.contract}_c`);
      for (const ev of u.subscribes) lines.push(`  ${u.contract}_c -.->|${ev}| ${m.name}`);
    }
  }
  return lines.join("\n");
}

// Per-module data view: only the entities that module owns.
export function erDiagram(entities: Entity[]): string {
  const lines = ["erDiagram"];
  for (const e of entities) {
    lines.push(`  ${e.name} {`);
    for (const f of e.fields) {
      const type = typeLabel(f.type).replace(/[^A-Za-z0-9_]/g, "_");
      const tag = e.key.includes(f.name) ? " PK" : "";
      lines.push(`    ${type} ${f.name}${tag}`);
    }
    lines.push(`  }`);
  }
  // Relationships inside a module: a field typed as another local entity.
  for (const e of entities) {
    for (const f of e.fields) {
      const target = refName(f.type);
      if (target && entities.some((x) => x.name === target)) {
        const many = f.type.kind === "list";
        lines.push(`  ${e.name} ||--${many ? "o{" : "||"} ${target} : ${f.name}`);
      }
    }
  }
  return lines.join("\n");
}
