// Generated from the plan. Edit the plan, not this file.
import type { Decimal, Result, Uuid } from "../../kernel.ts";

export interface GatewayApi {
  /** command */
  charge(input: {
    amount: Decimal;
    reference: string;
  }): Promise<Result<string, "Declined" | "ProviderDown">>;
}

export type GatewayEvents = {
};
