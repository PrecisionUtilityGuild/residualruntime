import type { Action, Constraint, Residual, State } from "./domain";

export type EscalationEvent = {
  kind: "escalation";
  phi: string;
  stepsWithoutEvidence: number;
  threshold: number;
};

export type DeadlockEvent = {
  kind: "deadlock";
  itemKind: "tension" | "deferred" | "evidence_gap";
  phi: string;
  stepsStuck: number;
  reason: string;
};

export type OscillationEvent = {
  kind: "oscillation";
  fingerprint: string;
  firstSeenStep: number;
  currentStep: number;
  cycleLength: number;
};

export type ResidualOverflowEvent = {
  kind: "overflow";
  field: "tensions" | "evidenceGaps" | "deferred" | "assumptions";
  count: number;
  limit: number;
};

export type InvalidAdjudicationEvent = {
  kind: "invalid_adjudication";
  phi1: string;
  phi2: string;
  winner: string;
  reason: string;
  source: "auto" | "manual";
};

export type SoftBlockedAction = {
  action: Action;
  unmetPreferences: Array<{ phi: string; weight: number }>;
};

export type ActionCausalAnnotation = {
  action: Action;
  blockedBy: string[];
  enabledBy: string[];
};

export type ReplayEvent = {
  input: { evidence?: Record<string, number>; constraints?: Constraint[]; adjudications?: Array<{ phi1: string; phi2: string; winner: string }> };
  before: { state: State; residual: Residual };
  afterDischarge: { statePre: State; residualPre: Residual };
  constraints: Constraint[];
  candidateActions: Action[];
  approvedActions: Action[];
  blockedActions: Action[];
  after: { state: State; residual: Residual };
};

export type StepResult = {
  stateNext: State;
  residualNext: Residual;
  actionsApproved: Action[];
  actionsBlocked: Action[];
  softBlocked: SoftBlockedAction[];
  approvedWith: ActionCausalAnnotation[];
  blockedWith: ActionCausalAnnotation[];
  escalations: EscalationEvent[];
  overflows: ResidualOverflowEvent[];
  oscillations: OscillationEvent[];
  fingerprintHistory: string[];
  autoAdjudications: Array<{ phi1: string; phi2: string; winner: string }>;
  invalidAdjudications: InvalidAdjudicationEvent[];
  deadlocks: DeadlockEvent[];
  emittedRevocable: Action[];
  revokedActions: Action[];
  replay: ReplayEvent;
};

export type ConflictReport = {
  conflicts: Array<{ phi: string; reason: string }>;
};
