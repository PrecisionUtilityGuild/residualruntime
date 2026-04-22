export type Constraint =
  | { type: "RequireEvidence"; phi: string; threshold: number }
  | { type: "Unresolved"; phi1: string; phi2: string }
  | { type: "Prop"; phi: string }
  | { type: "Prefer"; phi: string; weight: number }
  | { type: "Suspendable"; phi: string; condition: string };

export type Assumption = { kind: "assumption"; phi: string; weight: number; decayPerStep?: number; createdAt?: number };
export type Deferred = { kind: "deferred"; constraint: Constraint; dependencies: string[]; stepsStuck?: number; createdAt?: number };
export type Tension = { kind: "tension"; phi1: string; phi2: string; stepsAlive?: number; createdAt?: number };
export type EvidenceGap = {
  kind: "evidence_gap";
  phi: string;
  threshold: number;
  escalationSteps?: number;
  stepsWithoutEvidence?: number;
  createdAt?: number;
};

export function ageOf(item: { createdAt?: number }, nowMs: number): number | undefined {
  return item.createdAt !== undefined ? nowMs - item.createdAt : undefined;
}

export type Residual = {
  assumptions: Assumption[];
  deferred: Deferred[];
  tensions: Tension[];
  evidenceGaps: EvidenceGap[];
};

export type State = {
  commitments: Constraint[];
  tensions: Constraint[];
  belief: Record<string, number>;
  // Maps each believed phi to the set of phis that support it.
  // Used by AGM contraction to cascade-retract dependent beliefs.
  beliefSupport: Record<string, string[]>;
  rejected: string[];
  // Persists stepsWithoutEvidence across constraint oscillation so counters
  // are not reset when a RequireEvidence constraint is absent for one step.
  gapCounters: Record<string, number>;
};

export type SessionStatus = "active" | "closed";

export type SessionMetadata = {
  objectiveType?: string;
  objectiveRef?: string;
  title?: string;
  status: SessionStatus;
  createdAt: number;
  closedAt?: number;
};

export type SessionMetadataInput = {
  objectiveType?: string;
  objectiveRef?: string;
  title?: string;
  status?: SessionStatus;
  createdAt?: number;
  closedAt?: number;
};

export type EventContext = {
  branch?: string;
  commitSha?: string;
  worktreeId?: string;
  actorId?: string;
};

export type Action = {
  kind: "action";
  type: string;
  dependsOn?: string[];
  revocable?: boolean;
  // Optional resource declarations for cross-session conflict detection.
  readSet?: string[];
  writeSet?: string[];
};

export type Proposal = Action | Assumption | Deferred | Tension | EvidenceGap;

export type Input = {
  evidence?: Record<string, number>;
  constraints?: Constraint[];
  adjudications?: Array<{ phi1: string; phi2: string; winner: string }>;
};

export type TensionTimeoutPolicy = {
  maxSteps: number;
  resolve: (phi1: string, phi2: string) => string;
  // When set, fires when ageOf(tension, nowMs) >= wallClockMs instead of stepsAlive >= maxSteps.
  wallClockMs?: number;
};

export type ResidualDelta =
  | { kind: "adjudicate-tension"; phi1: string; phi2: string; winner: string; sufficient: boolean }
  | { kind: "satisfy-evidence-gap"; phi: string; requiredBelief: number; sufficient: boolean }
  | { kind: "commit-deferred-dependency"; phi: string; sufficient: boolean };

export type UnblockAnalysis = {
  permanent: boolean;
  deltas: ResidualDelta[];
};

export type ResidualLimits = {
  maxTensions?: number;
  maxEvidenceGaps?: number;
  maxDeferred?: number;
  maxAssumptions?: number;
};

export function createEmptyResidual(): Residual {
  return { assumptions: [], deferred: [], tensions: [], evidenceGaps: [] };
}

export function createInitialState(): State {
  return { commitments: [], tensions: [], belief: {}, beliefSupport: {}, rejected: [], gapCounters: {} };
}
