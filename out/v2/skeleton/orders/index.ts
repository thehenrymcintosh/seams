// Generated once from the plan as a starting point. Implement the module here.
import type { Publish } from "../kernel.ts";
import type * as Catalog from "../catalog/Catalog.contract.ts";
import type * as Orders from "./Orders.contract.ts";
import type * as Payments from "../payments/Payments.contract.ts";
import type { OrderRepository } from "./repositories.ts";

export type OrdersDeps = {
  catalog: Catalog.CatalogApi;
  payments: Payments.PaymentsApi;
  orderRepository: OrderRepository;
  publishOrders: Publish<Orders.OrdersEvents>;
};

export type OrdersModule = {
  orders: Orders.OrdersApi;
  on: {
    PaymentsPaymentCaptured(event: Payments.PaymentsEvents["PaymentCaptured"]): Promise<void>;
    PaymentsPaymentFailed(event: Payments.PaymentsEvents["PaymentFailed"]): Promise<void>;
  };
};

export function createOrders(deps: OrdersDeps): OrdersModule {
  void deps;
  return {
    orders: {
      async placeOrder() { throw todo("Orders.PlaceOrder"); },
      async cancelOrder() { throw todo("Orders.CancelOrder"); },
      async getOrder() { throw todo("Orders.GetOrder"); },
      async listForCustomer() { throw todo("Orders.ListForCustomer"); },
    },
    on: {
      async PaymentsPaymentCaptured() { throw todo("on Payments.PaymentCaptured"); },
      async PaymentsPaymentFailed() { throw todo("on Payments.PaymentFailed"); },
    },
  };
}

const todo = (what: string) => new Error(`not implemented: ${what}`);
