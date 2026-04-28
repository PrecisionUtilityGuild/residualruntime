import type {
  Action,
  AcquisitionMove,
  BlockerCertificate,
  EventContext,
  Input,
  Proposal,
  Residual,
  ResidualLimits,
  State,
  TensionTimeoutPolicy,
} from "./domain";
import type { ReplayEvent } from "./events";
import type { TransitionEngine } from "../transition";

export type RepairDirective = BlockerCertificate["next"];
export type RepairAdvice = BlockerCertificate["recommendations"];

export type RepairTraceEntry = {
  blockerId: string;
  blockerType: BlockerCertificate["blockerType"];
  sourceIndex: number;
  stableOrder: number;
};

type RepairIntentBase = {
  intentId: string;
  blockerId: string;
  blockerType: BlockerCertificate["blockerType"];
  atoms: string[];
  permanent: boolean;
  sufficient: boolean;
  ownership: BlockerCertificate["ownership"];
  advisory: RepairAdvice;
  trace: RepairTraceEntry;
};

export type RepairIntent =
  | (RepairIntentBase & {
      kind: "replan";
      resolution: "replan_required";
      strict: Extract<RepairDirective, { kind: "replan_without_rejected_atom" }>;
    })
  | (RepairIntentBase & {
      kind: "repair";
      resolution: "single_step" | "multi_step";
      strict: Exclude<RepairDirective, { kind: "replan_without_rejected_atom" }>;
    });

export type RepairTrace = {
  compiler: "compileRepairPlan";
  source: "blocker_certificates";
  ordering: "blockerId:asc";
  inputCount: number;
  intentCount: number;
  blockerIds: string[];
  permanentBlockerIds: string[];
  advisoryMoveCount: number;
  entries: RepairTraceEntry[];
};

export type RepairPlan = {
  intents: RepairIntent[];
  trace: RepairTrace;
  summary: {
    permanentBlockers: number;
    actionableIntents: number;
    requiresReplan: boolean;
    singleStepIntents: number;
    multiStepIntents: number;
  };
};

export type RepairAdapterCapability =
  | "query"
  | "run_check"
  | "request_approval"
  | "observe"
  | "adjudicate"
  | "coordinate";

export type RepairObservationProvenance = {
  adapterId: string;
  capability: RepairAdapterCapability;
  source: "strict" | "advisory";
  blockerId: string;
  intentId: string;
  target: string;
  observedAt: number;
  note?: string;
};

export type RepairObservation = {
  provenance: RepairObservationProvenance;
  inputPatch?: Input;
  proposalPatch?: Proposal[];
  contextPatch?: EventContext;
};

type RepairAdapterRequestBase = {
  cycle: number;
  intent: RepairIntent;
  targetAction: Action;
  state: State;
  residual: Residual;
  context?: EventContext;
};

export type RepairQueryRequest = RepairAdapterRequestBase & {
  capability: "query";
  source: "advisory";
  move: Extract<AcquisitionMove, { kind: "query" }>;
  target: string;
};

export type RepairRunCheckRequest = RepairAdapterRequestBase & {
  capability: "run_check";
  source: "strict" | "advisory";
  move?: Extract<AcquisitionMove, { kind: "run_check" }>;
  directive?: Extract<RepairDirective, { kind: "provide_evidence" }>;
  target: string;
};

export type RepairRequestApprovalRequest = RepairAdapterRequestBase & {
  capability: "request_approval";
  source: "strict" | "advisory";
  move?: Extract<AcquisitionMove, { kind: "request_approval" }>;
  directive?: Extract<RepairDirective, { kind: "satisfy_dependency" }>;
  target: string;
};

export type RepairObserveRequest = RepairAdapterRequestBase & {
  capability: "observe";
  source: "advisory";
  move: Extract<AcquisitionMove, { kind: "observe" }>;
  target: string;
};

export type RepairAdjudicateRequest = RepairAdapterRequestBase & {
  capability: "adjudicate";
  source: "strict";
  directive: Extract<RepairDirective, { kind: "adjudicate_tension" }>;
  target: string;
};

export type RepairCoordinateRequest = RepairAdapterRequestBase & {
  capability: "coordinate";
  source: "strict";
  directive: Extract<RepairDirective, { kind: "coordinate_session" }>;
  target: string;
};

export type RepairAdapterRequest =
  | RepairQueryRequest
  | RepairRunCheckRequest
  | RepairRequestApprovalRequest
  | RepairObserveRequest
  | RepairAdjudicateRequest
  | RepairCoordinateRequest;

export type RepairAdapterHandlers = {
  query?: (
    request: RepairQueryRequest
  ) => RepairObservation | RepairObservation[] | undefined;
  run_check?: (
    request: RepairRunCheckRequest
  ) => RepairObservation | RepairObservation[] | undefined;
  request_approval?: (
    request: RepairRequestApprovalRequest
  ) => RepairObservation | RepairObservation[] | undefined;
  observe?: (
    request: RepairObserveRequest
  ) => RepairObservation | RepairObservation[] | undefined;
  adjudicate?: (
    request: RepairAdjudicateRequest
  ) => RepairObservation | RepairObservation[] | undefined;
  coordinate?: (
    request: RepairCoordinateRequest
  ) => RepairObservation | RepairObservation[] | undefined;
};

export type RepairAdapter = {
  adapterId: string;
  capabilities: RepairAdapterHandlers;
};

export type SeededFakeObservation = Omit<RepairObservation, "provenance"> & {
  note?: string;
};

export type SeededFakeAdapterScript = Partial<
  Record<RepairAdapterCapability, SeededFakeObservation[]>
>;

export type SeededFakeAdapterOptions = {
  adapterId?: string;
  seed?: number;
  script?: SeededFakeAdapterScript;
};

export type RepairCycleTrace = {
  cycle: number;
  certificates: BlockerCertificate[];
  plan: RepairPlan;
  observations: RepairObservation[];
  generatedInput: Input;
  generatedProposals: Proposal[];
  generatedContext?: EventContext;
  stepResult?: {
    actionsApproved: Action[];
    actionsBlocked: Action[];
    replay: ReplayEvent;
  };
};

export type RunRepairCycleFailureCode =
  | "permanent_blocker"
  | "missing_capability"
  | "max_cycles_exceeded";

export type RunRepairCycleParams = {
  state: State;
  residual: Residual;
  targetAction: Action;
  adapter: RepairAdapter;
  maxCycles?: number;
  initialContext?: EventContext;
  fingerprintHistory?: string[];
  priorRevocable?: Action[];
  transitionEngine?: TransitionEngine;
  tensionTimeoutPolicy?: TensionTimeoutPolicy;
  deadlockThreshold?: number;
  residualLimits?: ResidualLimits;
  nowMs?: number;
};

export type RunRepairCycleResult = {
  status: "resolved" | "failed";
  failureCode?: RunRepairCycleFailureCode;
  failureMessage?: string;
  targetActionApproved: boolean;
  cycles: RepairCycleTrace[];
  state: State;
  residual: Residual;
  context?: EventContext;
  fingerprintHistory: string[];
  activeRevocable: Action[];
  lastReplay?: ReplayEvent;
};
