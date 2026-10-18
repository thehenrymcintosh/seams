// Generated once from the plan as a starting point. Implement the module here.
import type * as Gateway from "./Gateway.contract.ts";

export type GatewayDeps = {

};

export type GatewayModule = {
  gateway: Gateway.GatewayApi;
};

export function createGateway(deps: GatewayDeps): GatewayModule {
  void deps;
  return {
    gateway: {
      async charge() { throw todo("Gateway.Charge"); },
    },
  };
}

const todo = (what: string) => new Error(`not implemented: ${what}`);
