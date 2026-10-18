// Generated from the plan. Edit the plan, not this file.
import type { Order, OrderKey, OrderAggregate } from "./schema.ts";

export interface OrderRepository {
  get(key: OrderKey): Promise<OrderAggregate | null>;
  findByCustomerId(by: Pick<Order, "customerId">): Promise<OrderAggregate[]>;
  save(aggregate: OrderAggregate): Promise<void>;
}
