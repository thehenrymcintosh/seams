// Generated from the plan. Edit the plan, not this file.
import type { Payment, PaymentKey } from "./schema.ts";

export interface PaymentRepository {
  get(key: PaymentKey): Promise<Payment | null>;
  findByOrderId(by: Pick<Payment, "orderId">): Promise<Payment[]>;
  save(entity: Payment): Promise<void>;
}
