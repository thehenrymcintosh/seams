// Generated from the plan. Edit the plan, not this file.
import type { Decimal, Uuid } from "../kernel.ts";
import type * as Payments from "./Payments.contract.ts";

export type Payment = {
  id: Uuid;
  orderId: Uuid;
  amount: Decimal;
  status: Payments.PaymentStatus;
  providerRef: string | null;
  createdAt: Date;
};
export type PaymentKey = Pick<Payment, "id">;
