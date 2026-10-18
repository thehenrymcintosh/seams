// Generated from the plan: Payments / payments table (dynamodb).

/** Payment items in "payments". */
export const paymentKeys = {
  table: "payments",
  pk: (k: { id: string }) => `PAY#${k.id}`,
  byOrder: { index: "byOrder", pk: (k: { orderId: string }) => `ORDER#${k.orderId}`, sk: (k: { createdAt: string }) => `AT#${k.createdAt}` },
} as const;
