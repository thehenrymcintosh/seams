// Stable node ids. Notes, slices, diffs and the rendered document all refer to
// nodes by these, so they are derived from names and never from position.

export const ids = {
  module: (path: string) => path,          // "Payments" or "Payments/Gateway"
  aggregate: (m: string, a: string) => `${m}/aggregate/${a}`,
  entity: (m: string, e: string) => `${m}/entity/${e}`,
  contract: (m: string, c: string) => `${m}/contract/${c}`,
  operation: (m: string, c: string, o: string) => `${m}/contract/${c}/${o}`,
  event: (m: string, c: string, e: string) => `${m}/contract/${c}/${e}`,
  type: (m: string, c: string, t: string) => `${m}/contract/${c}/type/${t}`,
  store: (m: string, s: string) => `${m}/store/${s}`,
  binding: (m: string, s: string, e: string) => `${m}/store/${s}/${e}`,
  // Paths hold slashes, which separate id segments, so they are written with
  // the look-alike "∕" (U+2215).
  endpoint: (m: string, name: string) => `${m}/endpoint/${name.replace(/\//g, "\u2215")}`,
  port: (m: string, p: string) => `${m}/port/${p}`,
  signal: (m: string, s: string) => `${m}/signal/${s.replace(/\//g, "\u2215")}`,
  test: (m: string, t: string) => `${m}/test/${t.replace(/\//g, "\u2215")}`,
};
