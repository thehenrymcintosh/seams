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
};
