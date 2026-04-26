import { step } from "../runtime/engine";
import {
  createEmptyResidual,
  createInitialState,
  type Action,
  type Input,
  type Proposal,
  type Residual,
  type State,
} from "../runtime/model";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const DEPLOY_DEPENDS_ON = [
  "tests=passing",
  "security_scan",
  "staging_approved",
] as const;

export const DEPLOY_TO_PRODUCTION_ACTION: Action = {
  kind: "action",
  type: "DEPLOY_TO_PRODUCTION",
  dependsOn: [...DEPLOY_DEPENDS_ON],
};

export const DEPLOY_INITIAL_PROPOSALS: Proposal[] = [
  {
    kind: "tension",
    phi1: "tests=passing",
    phi2: "tests=failing",
  },
  {
    kind: "evidence_gap",
    phi: "security_scan",
    threshold: 0.8,
    escalationSteps: 5,
  },
  {
    kind: "deferred",
    constraint: { type: "Prop", phi: "staging_approved" },
    dependencies: ["lead_review=done"],
  },
];

export const DEPLOY_INITIAL_INPUT: Input = {};

export function createDeployRepairSeed(): { state: State; residual: Residual } {
  const seeded = step({
    state: createInitialState(),
    residual: createEmptyResidual(),
    input: deepClone(DEPLOY_INITIAL_INPUT),
    proposals: deepClone(DEPLOY_INITIAL_PROPOSALS),
  });

  return {
    state: deepClone(seeded.stateNext),
    residual: deepClone(seeded.residualNext),
  };
}
