// Generated from the plan. Edit the plan, not this file.
import type { Product, ProductKey } from "./schema.ts";

export interface ProductRepository {
  get(key: ProductKey): Promise<Product | null>;
  findBySku(by: Pick<Product, "sku">): Promise<Product[]>;
  findByActive(by: Pick<Product, "active">): Promise<Product[]>;
  save(entity: Product): Promise<void>;
}
