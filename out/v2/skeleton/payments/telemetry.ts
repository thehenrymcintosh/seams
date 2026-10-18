// Generated from the plan. Edit the plan, not this file.

export const signals = {
  "payments_total": { type: "metric", on: "Payments.StartPayment", fields: ["outcome"], alert: "Failed > 10% for 15m" },
  "payments.charge": { type: "trace", on: "Gateway.Charge", fields: ["provider", "amount"] },
  "payments.failed": { type: "log", on: "Payments.PaymentFailed", fields: ["orderId", "reason"] },
} as const;

type Signals = typeof signals;

export type Emit = <K extends keyof Signals>(name: K, fields: Record<Signals[K]["fields"][number], unknown>) => void;
