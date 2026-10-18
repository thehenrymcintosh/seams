// Plans written by hand, or saved by an older version, may leave out parts a
// module or binding has today. Loading fills them in once, so every reader can
// rely on the full shape instead of defending against missing arrays.

import type { Binding, Contract, Module, Plan } from "./ast.ts";
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
    provides: part("provides").map(normalizeContract),
    uses: part("uses").map((u) => ({ ...u, subscribes: u.subscribes ?? [] })),
    endpoints: part("endpoints").map((e) => ({ ...e, calls: e.calls ?? [] })),
    ports: part("ports").map((p) => ({ ...p, adapters: p.adapters ?? [] })),
    signals: part("signals").map((x) => ({ ...x, fields: x.fields ?? [] })),
    tests: part("tests").map((x) => ({ ...x, covers: x.covers ?? [], fakes: x.fakes ?? [] })),
    gaps: part("gaps"),
    stores: part("stores").map((st) => ({ ...st, holds: (st.holds ?? []).map(normalizeBinding) })),
    modules: part("modules").map(normalizeModule),
  };
}

const normalizeContract = (c: Contract): Contract => ({
  ...c, types: c.types ?? [], operations: (c.operations ?? []).map((o) => ({ ...o, input: o.input ?? [], errors: o.errors ?? [] })),
  events: (c.events ?? []).map((e) => ({ ...e, payload: e.payload ?? [] })),
});

const normalizeBinding = (b: Binding): Binding =>
  ({ ...b, columns: b.columns ?? [], indexes: b.indexes ?? [], gsis: b.gsis ?? [] });
