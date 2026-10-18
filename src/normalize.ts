// Plans written by hand, or saved by an older version, may leave out parts a
// module or binding has today. Loading fills them in once, so every reader can
// rely on the full shape instead of defending against missing arrays.

import type { Binding, Module, Plan } from "./ast.ts";
import type { PlanDocument } from "./doc.ts";

export function normalizeDocument(doc: PlanDocument): PlanDocument {
  return {
    ...doc,
    current: normalizePlan(doc.current),
    proposed: doc.proposed && normalizePlan(doc.proposed),
    slices: doc.slices ?? [], questions: doc.questions ?? [], decisions: doc.decisions ?? [], facts: doc.facts ?? {},
  };
}

export const normalizePlan = (plan: Plan): Plan => ({ ...plan, modules: plan.modules.map(normalizeModule) });

function normalizeModule(m: Module): Module {
  const part = <K extends keyof Module>(k: K) => (m[k] ?? []) as Module[K];
  return {
    ...m,
    entities: part("entities"), aggregates: part("aggregates"), repositories: part("repositories"),
    provides: part("provides"), uses: part("uses"), endpoints: part("endpoints"),
    ports: part("ports"), signals: part("signals"), tests: part("tests"), gaps: part("gaps"),
    stores: part("stores").map((st) => ({ ...st, holds: st.holds.map(normalizeBinding) })),
    modules: part("modules").map(normalizeModule),
  };
}

const normalizeBinding = (b: Binding): Binding =>
  ({ ...b, columns: b.columns ?? [], indexes: b.indexes ?? [], gsis: b.gsis ?? [] });
