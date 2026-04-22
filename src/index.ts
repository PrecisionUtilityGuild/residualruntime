// ── Core step functions ──────────────────────────────────────────────────────
export { step, naiveStep, discharge, lift } from "./runtime/engine";

// ── Predicates (action blocking logic) ──────────────────────────────────────
export { blocks, blockingAtoms, filterBlocked, whatWouldUnblock } from "./runtime/predicates";

// ── Policies (fingerprint, oscillation, soft-blocking, causal annotations) ──
export { computeFingerprint, detectOscillations, computeSoftBlocked, buildCausalAnnotations } from "./runtime/policies";

// ── Constraints (merge, conflict detection) ──────────────────────────────────
export { mergeConstraints, detectConflicts } from "./runtime/constraints";

// ── Transition engine ────────────────────────────────────────────────────────
export { transition, DefaultTransitionEngine } from "./runtime/transition";
export type { TransitionEngine } from "./runtime/transition";

// ── Store (log, replay) ──────────────────────────────────────────────────────
export { appendStep, readLog, replayLog, createInMemoryLog, ReplayMismatchError, CcpVerificationError } from "./runtime/store";
export type { StepLogAdapter } from "./runtime/store";
export { createFileLog } from "./runtime/fileAdapter";
export { createResidualMcpServer, runStdioServer } from "./mcp/server";
export { SessionManager } from "./mcp/sessions";
export type { StepSessionRequest, SessionSnapshot, SessionListItem, LegacyImportResult } from "./mcp/sessions";

// ── CCP₀ verification ────────────────────────────────────────────────────────
export { translateTrace, verifyCcpTrace } from "./runtime/verify/ccp0";
export type { CcpStore, CcpTrace, CcpOp, TellOp, AskOp } from "./runtime/verify/ccp0";

// ── Observability ────────────────────────────────────────────────────────────
export { diffStep, computeMetrics, summarizeTrace } from "./runtime/observe";
export type { StepDiff, StepMetrics } from "./runtime/observe";

// ── Factory functions ─────────────────────────────────────────────────────────
export { createEmptyResidual, createInitialState, ageOf } from "./runtime/model";

// ── Domain types ─────────────────────────────────────────────────────────────
export type {
  Constraint,
  Assumption,
  Deferred,
  Tension,
  EvidenceGap,
  Residual,
  State,
  SessionStatus,
  SessionMetadata,
  SessionMetadataInput,
  EventContext,
  Action,
  Proposal,
  Input,
  TensionTimeoutPolicy,
  ResidualLimits,
  ResidualDelta,
  UnblockAnalysis,
  AcquisitionMove,
  BlockerCertificate,
} from "./runtime/model";

// ── Event / result types ─────────────────────────────────────────────────────
export type {
  EscalationEvent,       // escalations[] on StepResult
  DeadlockEvent,
  OscillationEvent,
  ResidualOverflowEvent,
  InvalidAdjudicationEvent,
  SoftBlockedAction,
  ActionCausalAnnotation,
  SessionConflictType,
  SessionConflictScope,
  SessionConflictUnblock,
  SessionConflictEvent,
  SessionArbitrationMode,
  SessionArbitrationOutcome,
  SessionArbitrationPolicy,
  SessionArbitrationEvent,
  ReplayEvent,
  StepResult,
  ConflictReport,
} from "./runtime/model";
