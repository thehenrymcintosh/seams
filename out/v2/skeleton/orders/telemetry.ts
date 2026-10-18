// Generated from the plan. Edit the plan, not this file.

export const signals = {
  "orders_placed_total": { type: "metric", on: "Orders.PlaceOrder", fields: ["outcome"] },
  "orders.payment_failed": { type: "log", on: "Payments.PaymentFailed", fields: ["orderId", "reason"] },
} as const;

type Signals = typeof signals;

export type Emit = <K extends keyof Signals>(name: K, fields: Record<Signals[K]["fields"][number], unknown>) => void;
