// A plan document: everything one planning (or learning) session produces.
// It is embedded as JSON in the rendered HTML, so the file is both the page
// and the source the agent reads back on the next round.

import type { Plan } from "./ast.ts";

export type PlanDocument = {
  format: "plan-doc/1";
  title: string;
  intent: string;                    // the prompt the session started from
  mode: "plan" | "learn";            // learn = no proposed change
  current: Plan;                     // the system as the agent understands it today
  proposed?: Plan;                   // the system after the change
  slices: Slice[];                   // phases of the change, in order
  questions: Question[];             // open, for the human to answer
  decisions: Decision[];             // settled, with the reason
  facts: Record<string, Fact[]>;     // node id -> deterministic evidence from the code
};

// A slice is a set of nodes in the proposed tree that change together and can
// ship on their own. Changes from the diff are assigned by node id.
export type Slice = { name: string; goal: string; nodes: string[]; notes?: string };

export type Question = { text: string; node?: string; options?: string[] };

export type Decision = { text: string; why: string; node?: string };

export type Fact = { label: string; value: string | number; detail?: string };
