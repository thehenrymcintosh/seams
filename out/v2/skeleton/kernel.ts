// Generated. Shared primitives every module may use.
export type Uuid = string & { readonly __brand?: "Uuid" };
export type Decimal = string & { readonly __brand?: "Decimal" };

export type Result<T, E extends string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type Publish<Events> = <K extends keyof Events>(name: K, payload: Events[K]) => Promise<void>;
