// Generated from the plan. Edit the plan, not this file.
import type { Decimal, Result, Uuid } from "../kernel.ts";

export type PaymentStatus = "Pending" | "Captured" | "Failed";

export interface PaymentsApi {
  /** command */
  startPayment(input: {
    orderId: Uuid;
    amount: Decimal;
  }): Promise<Result<Uuid, "AlreadyPaid">>;
  /** query */
  getStatus(input: {
    orderId: Uuid;
  }): Promise<Result<PaymentStatus, "NotFound">>;
}

export type PaymentsEvents = {
  PaymentCaptured: {
    paymentId: Uuid;
    orderId: Uuid;
  };
  PaymentFailed: {
    orderId: Uuid;
    reason: string;
  };
};
