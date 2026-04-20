export type {
  Constraint,
  Assumption,
  Deferred,
  Tension,
  EvidenceGap,
  Residual,
  State,
  Action,
  Proposal,
  Input,
  TensionTimeoutPolicy,
  ResidualLimits,
  ResidualDelta,
  UnblockAnalysis,
} from "./types/domain";
export { createEmptyResidual, createInitialState, ageOf } from "./types/domain";

export type {
  EscalationEvent,
  DeadlockEvent,
  OscillationEvent,
  ResidualOverflowEvent,
  InvalidAdjudicationEvent,
  SoftBlockedAction,
  ActionCausalAnnotation,
  ReplayEvent,
  StepResult,
  ConflictReport,
} from "./types/events";
