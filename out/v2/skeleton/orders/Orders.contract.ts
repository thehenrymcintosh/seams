// Generated from the plan. Edit the plan, not this file.
import type { Decimal, Result, Uuid } from "../kernel.ts";
import type * as Catalog from "../catalog/Catalog.contract.ts";

export type OrderStatus = "AwaitingPayment" | "Paid" | "PaymentFailed" | "Cancelled";

export type LineInput = {
  productId: Uuid;
  quantity: number;
};

export type OrderLineView = {
  product: Catalog.ProductSummary;
  quantity: number;
  unitPrice: Decimal;
};

export type OrderView = {
  id: Uuid;
  status: OrderStatus;
  total: Decimal;
  lines: OrderLineView[];
};

export interface OrdersApi {
  /** command */
  placeOrder(input: {
    customerId: Uuid;
    lines: LineInput[];
  }): Promise<Result<OrderView, "EmptyOrder" | "UnknownProduct">>;
  /** command */
  cancelOrder(input: {
    id: Uuid;
  }): Promise<Result<void, "NotFound" | "AlreadyCancelled" | "AlreadyPaid">>;
  /** query */
  getOrder(input: {
    id: Uuid;
  }): Promise<Result<OrderView, "NotFound">>;
  /** query */
  listForCustomer(input: {
    customerId: Uuid;
  }): Promise<OrderView[]>;
}

export type OrdersEvents = {
  OrderPlaced: {
    orderId: Uuid;
    total: Decimal;
  };
  OrderPaid: {
    orderId: Uuid;
  };
};
