// Generated once from the plan as a starting point. Implement the module here.
import type { Publish } from "../kernel.ts";
import type * as Gateway from "./gateway/Gateway.contract.ts";
import type * as Payments from "./Payments.contract.ts";
import type { PaymentRepository } from "./repositories.ts";
import type { Clock } from "./ports.ts";
import type { Emit } from "./telemetry.ts";

export type PaymentsDeps = {
  gateway: Gateway.GatewayApi;
  paymentRepository: PaymentRepository;
  clock: Clock;
  emit: Emit;
  publishPayments: Publish<Payments.PaymentsEvents>;
};

export type PaymentsModule = {
  payments: Payments.PaymentsApi;
};

export function createPayments(deps: PaymentsDeps): PaymentsModule {
  void deps;
  return {
    payments: {
      async startPayment() { throw todo("Payments.StartPayment"); },
      async getStatus() { throw todo("Payments.GetStatus"); },
    },
  };
}

const todo = (what: string) => new Error(`not implemented: ${what}`);
