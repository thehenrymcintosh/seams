// Type expressions as text. One printer for every view that shows a type as
// plain text; the page and the skeleton resolve references too, so they keep
// their own walkers.

import type { TypeExpr } from "./ast.ts";

// `optional` is how a missing value is written: "?" for labels, " | null" for code.
export function typeLabel(t: TypeExpr, optional = "?"): string {
  switch (t.kind) {
    case "prim": return t.name;
    case "ref": return t.name;
    case "list": return `${typeLabel(t.of, optional)}[]`;
    case "optional": return `${typeLabel(t.of, optional)}${optional}`;
  }
}

// The type a reference points at, through lists and optionals.
export function refName(t: TypeExpr): string | null {
  if (t.kind === "ref") return t.name;
  if (t.kind === "list" || t.kind === "optional") return refName(t.of);
  return null;
}
