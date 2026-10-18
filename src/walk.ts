// Modules nest. Most rules and views work on every module in the tree, so
// they walk it flat; each entry knows its parent and its path, which is also
// its node id ("Payments/Gateway").

import type { Module, Plan } from "./ast.ts";

export type Placed = { module: Module; parent: Module | null; path: string; ancestors: Module[] };

export function walk(plan: Plan): Placed[] {
  const out: Placed[] = [];
  const visit = (m: Module, parent: Module | null, prefix: string, ancestors: Module[]) => {
    const path = prefix ? `${prefix}/${m.name}` : m.name;
    out.push({ module: m, parent, path, ancestors });
    for (const c of m.modules) visit(c, m, path, [...ancestors, m]);
  };
  for (const m of plan.modules) visit(m, null, "", []);
  return out;
}

export const pathsOf = (plan: Plan) => new Map(walk(plan).map((p) => [p.module, p.path]));
