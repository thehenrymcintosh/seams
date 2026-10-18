// Generated from the plan. Edit the plan, not this file.
import type { Decimal, Result, Uuid } from "../kernel.ts";

export type ProductSummary = {
  id: Uuid;
  name: string;
  price: Decimal;
};

export interface CatalogApi {
  /** query */
  getProduct(input: {
    id: Uuid;
  }): Promise<Result<ProductSummary, "NotFound">>;
  /** query */
  listActive(): Promise<ProductSummary[]>;
}

export type CatalogEvents = {
  ProductPriceChanged: {
    productId: Uuid;
    price: Decimal;
  };
};
