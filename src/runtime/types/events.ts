import type { Action, Constraint, EventContext, Residual, State } from "./domain";

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

export type SessionConflictType = "write_write" | "read_write";

export type SessionConflictScope = {
  kind: "branch" | "worktree";
  value: string;
};

export type SessionConflictUnblock = {
  kind:
    | "wait_for_other_session"
    | "split_scope"
    | "narrow_resource_sets"
    | "integration_action";
  detail: string;
};

export type SessionConflictEvent = {
  kind: "session_conflict";
  action: Action;
  otherAction: Action;
  otherSessionId: string;
  conflictType: SessionConflictType;
  resource: string;
  scope: SessionConflictScope;
  reason: string;
  unblock: SessionConflictUnblock[];
};

export type SessionArbitrationMode = "serialize_first" | "branch_split_required";

export type SessionArbitrationOutcome =
  | "serialize_wait"
  | "branch_split_required";

export type SessionArbitrationPolicy = {
  enabled: boolean;
  defaultMode: SessionArbitrationMode;
  modeByConflictType: Partial<
    Record<SessionConflictType, SessionArbitrationMode>
  >;
  objectiveTypePriority: Record<string, number>;
};

export type SessionArbitrationEvent = {
  kind: "session_arbitration";
  action: Action;
  otherAction: Action;
  sessionId: string;
  otherSessionId: string;
  conflictType: SessionConflictType;
  resource: string;
  scope: SessionConflictScope;
  mode: SessionArbitrationMode;
  outcome: SessionArbitrationOutcome;
  preferredSessionId: string;
  precedence: {
    conflictRank: number;
    sessionPriority: number;
    otherSessionPriority: number;
    tieBreak: string;
  };
  reason: string;
  unblock: SessionConflictUnblock[];
};

export type ReplayEvent = {
  context?: EventContext;
  input: { evidence?: Record<string, number>; constraints?: Constraint[]; adjudications?: Array<{ phi1: string; phi2: string; winner: string }> };
  before: { state: State; residual: Residual };
  afterDischarge: { statePre: State; residualPre: Residual };
  constraints: Constraint[];
  candidateActions: Action[];
  approvedActions: Action[];
  blockedActions: Action[];
  sessionEvents?: {
    conflicts: SessionConflictEvent[];
    arbitrations: SessionArbitrationEvent[];
  };
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
  sessionArbitrationPolicy: SessionArbitrationPolicy;
  sessionConflicts: SessionConflictEvent[];
  sessionArbitrations: SessionArbitrationEvent[];
  emittedRevocable: Action[];
  revokedActions: Action[];
  replay: ReplayEvent;
};

export type ConflictReport = {
  conflicts: Array<{ phi: string; reason: string }>;
};
