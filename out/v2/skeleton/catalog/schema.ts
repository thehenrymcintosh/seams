// Generated from the plan. Edit the plan, not this file.
import type { Decimal, Uuid } from "../kernel.ts";

export type Product = {
  id: Uuid;
  sku: string;
  name: string;
  price: Decimal;
  active: boolean;
};
export type ProductKey = Pick<Product, "id">;
