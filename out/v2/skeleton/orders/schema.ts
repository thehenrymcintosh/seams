// Generated from the plan. Edit the plan, not this file.
import type { Decimal, Uuid } from "../kernel.ts";
import type * as Orders from "./Orders.contract.ts";

export type Order = {
  id: Uuid;
  customerId: Uuid;
  status: Orders.OrderStatus;
  total: Decimal;
  placedAt: Date;
  paymentId: Uuid | null;
};
export type OrderKey = Pick<Order, "id">;

/** Price is copied at order time; Catalog prices may change later. */
export type OrderLine = {
  id: Uuid;
  orderId: Uuid;
  productId: Uuid;
  quantity: number;
  unitPrice: Decimal;
};
export type OrderLineKey = Pick<OrderLine, "id">;

/**
 * Invariants:
 * - Total equals the sum of its lines.
 * - Lines cannot change once the order is placed.
 * - Status only moves forward: AwaitingPayment, then Paid or PaymentFailed.
 */
export type OrderAggregate = {
  root: Order;
  orderLines: OrderLine[];
};
