// Generated once from the plan as a starting point. Implement the module here.
import type { Publish } from "../kernel.ts";
import type * as Catalog from "./Catalog.contract.ts";
import type { ProductRepository } from "./repositories.ts";

export type CatalogDeps = {
  productRepository: ProductRepository;
  publishCatalog: Publish<Catalog.CatalogEvents>;
};

export type CatalogModule = {
  catalog: Catalog.CatalogApi;
};

export function createCatalog(deps: CatalogDeps): CatalogModule {
  void deps;
  return {
    catalog: {
      async getProduct() { throw todo("Catalog.GetProduct"); },
      async listActive() { throw todo("Catalog.ListActive"); },
    },
  };
}

const todo = (what: string) => new Error(`not implemented: ${what}`);
