import { dischargeAll } from "./discharge";
import { createHash } from "node:crypto";
import { DEFAULT_POLICY_VERSION, REPLAY_SCHEMA_VERSION, RUNTIME_VERSION } from "./version";
import { pruneMaterializedDeferred } from "./deferredState";
import { contractBelief } from "./discharge/tensions";
import { mergeConstraints } from "./constraints";
import { DefaultTransitionEngine, type TransitionEngine } from "./transition";
import { blocks, filterBlocked } from "./predicates";
import { computeFingerprint, detectOscillations, computeSoftBlocked, buildCausalAnnotations, computeOverflows, computeDeadlocks } from "./policies";
import {
  ageOf,
  createEmptyResidual,
  type Action,
  type ActionCausalAnnotation,
  type Constraint,
  type EscalationEvent,
  type EvidenceGap,
  type InvalidAdjudicationEvent,
  type IdempotencyEvent,
  type Input,
  type Proposal,
  type ReopenAppliedEvent,
  type ReopenBlockedEvent,
  type ReopenSignal,
  type Residual,
  type ResidualLimits,
  type SessionArbitrationPolicy,
  type RiskEscalationEvent,
  type RiskTier,
  type State,
  type StepResult,
  type TensionTimeoutPolicy,
} from "./model";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;

  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(objectValue[key])}`);
  return `{${entries.join(",")}}`;
}

function hashDecision(payload: unknown): string {
  const stripped = stripVolatileForHash(payload);
  return createHash("sha256").update(stableSerialize(stripped)).digest("hex");
}

function stripVolatileForHash(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripVolatileForHash(item));

  const objectValue = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(objectValue)) {
    if (key === "createdAt") continue;
    normalized[key] = stripVolatileForHash(inner);
  }
  return normalized;
}

function actionOrderKey(action: Action): string {
  return stableSerialize({
    type: action.type,
    operationId: action.operationId,
    riskTier: action.riskTier ?? "medium",
    dependsOn: (action.dependsOn ?? []).slice().sort(),
    readSet: (action.readSet ?? []).slice().sort(),
    writeSet: (action.writeSet ?? []).slice().sort(),
    revocable: action.revocable === true,
  });
}

function actionOperationFingerprint(action: Action): string {
  return stableSerialize({
    type: action.type,
    riskTier: action.riskTier ?? "medium",
    dependsOn: (action.dependsOn ?? []).slice().sort(),
    readSet: (action.readSet ?? []).slice().sort(),
    writeSet: (action.writeSet ?? []).slice().sort(),
    revocable: action.revocable === true,
  });
}

function applyIdempotencyGate(params: {
  approvedActions: Action[];
  blockedActions: Action[];
  priorFingerprints?: Record<string, string>;
}): {
  approvedActions: Action[];
  blockedActions: Action[];
  blockedByMarkers: string[];
  idempotencyEvents: IdempotencyEvent[];
} {
  const approved: Action[] = [];
  const blocked = [...params.blockedActions];
  const blockedByMarkers: string[] = [];
  const idempotencyEvents: IdempotencyEvent[] = [];
  const knownFingerprints = { ...(params.priorFingerprints ?? {}) };

  for (const action of params.approvedActions) {
    const operationId = action.operationId?.trim();
    if (!operationId) {
      approved.push(action);
      continue;
    }

    const fingerprint = actionOperationFingerprint(action);
    const prior = knownFingerprints[operationId];
    if (prior === undefined) {
      knownFingerprints[operationId] = fingerprint;
      approved.push(action);
      continue;
    }

    if (prior === fingerprint) {
      idempotencyEvents.push({
        kind: "idempotency",
        operationId,
        action,
        outcome: "duplicate_approved_ignored",
        reason: `Operation "${operationId}" already executed with identical fingerprint; duplicate approval ignored.`,
      });
      continue;
    }

    blocked.push(action);
    blockedByMarkers.push(`idempotency:operation_conflict_blocked:${operationId}`);
    idempotencyEvents.push({
      kind: "idempotency",
      operationId,
      action,
      outcome: "operation_conflict_blocked",
      reason: `Operation "${operationId}" re-used with a different fingerprint; action blocked to preserve idempotency contract.`,
    });
  }

  return {
    approvedActions: sortActions(approved),
    blockedActions: sortActions(blocked),
    blockedByMarkers: blockedByMarkers.sort(),
    idempotencyEvents: [...idempotencyEvents].sort((left, right) =>
      stableSerialize(left).localeCompare(stableSerialize(right))
    ),
  };
}

function resolveRiskTier(action: Action): RiskTier {
  return action.riskTier ?? "medium";
}

function buildRiskEscalations(blocked: Action[]): RiskEscalationEvent[] {
  return blocked
    .filter((action) => {
      const tier = resolveRiskTier(action);
      return tier === "high" || tier === "critical";
    })
    .map((action) => ({
      kind: "risk_escalation" as const,
      action,
      tier: resolveRiskTier(action),
      reason: "blocked_high_risk_action" as const,
      requiredHumanReview: true as const,
    }))
    .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
}

function sortActions(actions: Action[]): Action[] {
  return [...actions].sort((left, right) => actionOrderKey(left).localeCompare(actionOrderKey(right)));
}

function constraintOrderKey(constraint: Constraint): string {
  return stableSerialize(constraint);
}

function sortConstraints(constraints: Constraint[]): Constraint[] {
  return [...constraints].sort((left, right) =>
    constraintOrderKey(left).localeCompare(constraintOrderKey(right))
  );
}

function sortEscalations(escalations: EscalationEvent[]): EscalationEvent[] {
  return [...escalations].sort((left, right) => {
    if (left.phi !== right.phi) return left.phi.localeCompare(right.phi);
    if (left.threshold !== right.threshold) return left.threshold - right.threshold;
    return left.stepsWithoutEvidence - right.stepsWithoutEvidence;
  });
}

const NOOP_SESSION_ARBITRATION_POLICY: SessionArbitrationPolicy = {
  enabled: false,
  defaultMode: "serialize_first",
  modeByConflictType: {},
  objectiveTypePriority: {},
};

const DEFAULT_REPLAY_ATTESTATION = {
  runtimeVersion: RUNTIME_VERSION,
  schemaVersion: REPLAY_SCHEMA_VERSION,
  policyVersion: DEFAULT_POLICY_VERSION,
} as const;

// Shallow-freeze in test/dev mode so callers discover accidental mutation early.
// Production skips the freeze to avoid the overhead.
function freezeIfTest<T extends object>(obj: T): T {
  if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") {
    Object.freeze(obj);
  }
  return obj;
}

function unresolvedKey(phi1: string, phi2: string): string {
  return [phi1, phi2].sort().join("\0");
}

function hasRejectedPair(state: State, phi1: string, phi2: string): boolean {
  return state.rejected.includes(phi1) || state.rejected.includes(phi2);
}

function normalizeReopenSignalKey(signal: ReopenSignal): string {
  return unresolvedKey(signal.phi1, signal.phi2);
}

function enforceReopenPolicy(params: {
  input: Input;
  proposals: Proposal[];
  statePre: State;
  residualPre: Residual;
  residualBefore: Residual;
}): {
  input: Input;
  proposals: Proposal[];
  reopenApplied: ReopenAppliedEvent[];
  reopenBlocked: ReopenBlockedEvent[];
} {
  const reopenSignals = params.input.reopenSignals ?? [];
  const signalByKey = new Map<string, ReopenSignal>();
  for (const signal of reopenSignals) {
    const key = normalizeReopenSignalKey(signal);
    if (!signalByKey.has(key)) signalByKey.set(key, signal);
  }

  const appliedKeys = new Set<string>();
  const reopenApplied: ReopenAppliedEvent[] = [];
  const reopenBlocked: ReopenBlockedEvent[] = [];

  const applySignalIfPresent = (phi1: string, phi2: string): boolean => {
    const key = unresolvedKey(phi1, phi2);
    const signal = signalByKey.get(key);
    if (!signal) return false;

    if (!appliedKeys.has(key)) {
      appliedKeys.add(key);
      params.statePre.rejected = params.statePre.rejected.filter(
        (phi) => phi !== phi1 && phi !== phi2
      );
      params.statePre.commitments = params.statePre.commitments.filter(
        (constraint) =>
          constraint.type !== "Prop" ||
          (constraint.phi !== phi1 && constraint.phi !== phi2)
      );
      contractBelief(params.statePre, phi1);
      contractBelief(params.statePre, phi2);
      reopenApplied.push({
        kind: "reopen_applied",
        phi1,
        phi2,
        source: signal.source,
        reason: signal.reason,
      });
    }

    return true;
  };

  const blockSilentReopen = (
    phi1: string,
    phi2: string,
    attemptedVia: ReopenBlockedEvent["attemptedVia"]
  ) => {
    reopenBlocked.push({
      kind: "reopen_blocked",
      phi1,
      phi2,
      attemptedVia,
      reason:
        "Resolved tension cannot reopen silently. Provide input.reopenSignals with source and reason to reopen.",
      requiredSignal: "input.reopenSignals",
    });
  };

  const filteredConstraints: Constraint[] = [];
  for (const constraint of params.input.constraints ?? []) {
    if (constraint.type !== "Unresolved") {
      filteredConstraints.push(constraint);
      continue;
    }

    if (!hasRejectedPair(params.statePre, constraint.phi1, constraint.phi2)) {
      filteredConstraints.push(constraint);
      continue;
    }

    if (applySignalIfPresent(constraint.phi1, constraint.phi2)) {
      filteredConstraints.push(constraint);
      continue;
    }

    blockSilentReopen(constraint.phi1, constraint.phi2, "constraint");
  }

  const filteredProposals: Proposal[] = [];
  for (const proposal of params.proposals) {
    if (proposal.kind !== "tension") {
      filteredProposals.push(proposal);
      continue;
    }

    if (!hasRejectedPair(params.statePre, proposal.phi1, proposal.phi2)) {
      filteredProposals.push(proposal);
      continue;
    }

    if (applySignalIfPresent(proposal.phi1, proposal.phi2)) {
      filteredProposals.push(proposal);
      continue;
    }

    blockSilentReopen(proposal.phi1, proposal.phi2, "proposal");
  }

  const priorTensionKeys = new Set(
    params.residualBefore.tensions.map((tension) =>
      unresolvedKey(tension.phi1, tension.phi2)
    )
  );
  params.residualPre.tensions = params.residualPre.tensions.filter((tension) => {
    if (!hasRejectedPair(params.statePre, tension.phi1, tension.phi2)) {
      return true;
    }
    if (applySignalIfPresent(tension.phi1, tension.phi2)) {
      return true;
    }

    const key = unresolvedKey(tension.phi1, tension.phi2);
    if (!priorTensionKeys.has(key)) {
      blockSilentReopen(tension.phi1, tension.phi2, "residual");
    }
    return false;
  });

  return {
    input: { ...params.input, constraints: filteredConstraints },
    proposals: filteredProposals,
    reopenApplied,
    reopenBlocked,
  };
}

export function discharge(
  residual: Residual,
  state: State,
  input: Input
): { residualPre: Residual; statePre: State; escalatedGaps: EvidenceGap[]; invalidAdjudications: InvalidAdjudicationEvent[] } {
  const residualPre = deepClone(residual);
  const statePre = deepClone(state);
  const { escalated, invalidAdjudications } = dischargeAll(residualPre, statePre, input);
  return { residualPre, statePre, escalatedGaps: escalated, invalidAdjudications };
}

export function lift(residualPre: Residual): Constraint[] {
  return [
    ...residualPre.tensions.map((t) => ({ type: "Unresolved", phi1: t.phi1, phi2: t.phi2 } as const)),
    ...residualPre.evidenceGaps.map(
      (g) => ({ type: "RequireEvidence", phi: g.phi, threshold: g.threshold } as const)
    ),
  ];
}

// naiveStep runs the same pipeline as step() but approves all candidates without blocking.
// Used as the "current systems" baseline in the concrete failure case demo.
export function naiveStep(params: {
  state: State;
  residual: Residual;
  input: Input;
  proposals?: Proposal[];
  transitionEngine?: TransitionEngine;
}): StepResult {
  const { state, residual, input } = params;
  const proposals = params.proposals ?? [];
  const engine = params.transitionEngine ?? new DefaultTransitionEngine();
  const beforeState = deepClone(state);
  const beforeResidual = deepClone(residual);

  const { residualPre, statePre, escalatedGaps, invalidAdjudications } = discharge(residual, state, input);
  const constraints = sortConstraints(mergeConstraints(input.constraints ?? [], lift(residualPre)));
  const { stateNext, actionsCandidate, residualNew } = engine.run(statePre, constraints, proposals, residualPre);
  pruneMaterializedDeferred(residualNew, stateNext);
  const escalations: EscalationEvent[] = sortEscalations(escalatedGaps.map((g) => ({
    kind: "escalation",
    phi: g.phi,
    stepsWithoutEvidence: g.stepsWithoutEvidence ?? 0,
    threshold: g.threshold,
  })));
  const candidateActionsSorted = sortActions(actionsCandidate);
  const approvedActionsSorted = candidateActionsSorted;
  const invalidAdjudicationsSorted = [...invalidAdjudications]
    .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
  const emittedRevocableSorted = sortActions(
    approvedActionsSorted.filter((a) => a.revocable === true)
  );
  const decisionHash = hashDecision({
    input,
    constraints,
    candidateActions: candidateActionsSorted,
    approvedActions: approvedActionsSorted,
    blockedActions: [],
    stateNext,
    residualNext: residualNew,
    escalations,
    invalidAdjudications: invalidAdjudicationsSorted,
  });

  return {
    decisionHash,
    attestation: DEFAULT_REPLAY_ATTESTATION,
    stateNext: freezeIfTest(stateNext),
    residualNext: freezeIfTest(residualNew),
    actionsApproved: approvedActionsSorted,
    actionsBlocked: [],
    softBlocked: computeSoftBlocked(approvedActionsSorted, constraints),
    approvedWith: [],
    blockedWith: [],
    escalations,
    overflows: [],
    oscillations: [],
    fingerprintHistory: [],
    autoAdjudications: [],
    invalidAdjudications: invalidAdjudicationsSorted,
    reopenApplied: [],
    reopenBlocked: [],
    deadlocks: [],
    sessionArbitrationPolicy: NOOP_SESSION_ARBITRATION_POLICY,
    sessionConflicts: [],
    sessionArbitrations: [],
    riskEscalations: [],
    idempotencyEvents: [],
    emittedRevocable: emittedRevocableSorted,
    revokedActions: [],
    replay: {
      decisionHash,
      attestation: DEFAULT_REPLAY_ATTESTATION,
      input: deepClone(input),
      before: { state: beforeState, residual: beforeResidual },
      afterDischarge: { statePre: deepClone(statePre), residualPre: deepClone(residualPre) },
      constraints: deepClone(constraints),
      candidateActions: deepClone(candidateActionsSorted),
      approvedActions: deepClone(approvedActionsSorted),
      blockedActions: [],
      riskEscalations: [],
      idempotencyEvents: [],
      after: { state: deepClone(stateNext), residual: deepClone(residualNew) },
    },
  };
}

export function step(params: {
  state: State;
  residual: Residual;
  input: Input;
  proposals?: Proposal[];
  transitionEngine?: TransitionEngine;
  tensionTimeoutPolicy?: TensionTimeoutPolicy;
  deadlockThreshold?: number;
  residualLimits?: ResidualLimits;
  fingerprintHistory?: string[];
  oscillationWindowSteps?: number;
  priorRevocable?: Action[];
  nowMs?: number;
  priorOperationFingerprints?: Record<string, string>;
}): StepResult {
  const { state, residual, input } = params;
  const proposals = params.proposals ?? [];
  const engine = params.transitionEngine ?? new DefaultTransitionEngine();
  const policy = params.tensionTimeoutPolicy;
  const dlThreshold = params.deadlockThreshold ?? 10;
  const limits = params.residualLimits;
  const oscWindow = params.oscillationWindowSteps ?? 10;
  const incomingHistory = params.fingerprintHistory ?? [];
  const priorRevocable = params.priorRevocable ?? [];
  const nowMs = params.nowMs ?? Date.now();
  const beforeState = deepClone(state);
  const beforeResidual = deepClone(residual);

  const { residualPre, statePre, escalatedGaps, invalidAdjudications } = discharge(residual, state, input);
  const reopenPolicy = enforceReopenPolicy({
    input,
    proposals,
    statePre,
    residualPre,
    residualBefore: residual,
  });
  const effectiveInput = reopenPolicy.input;
  const effectiveProposals = reopenPolicy.proposals;

  const autoAdjudications: Array<{ phi1: string; phi2: string; winner: string }> = [];
  if (policy) {
    residualPre.tensions = residualPre.tensions.filter((t) => {
      const timedOut = policy.wallClockMs !== undefined
        ? (ageOf(t, nowMs) ?? 0) >= policy.wallClockMs
        : (t.stepsAlive ?? 0) >= policy.maxSteps;
      if (timedOut) {
        const winner = policy.resolve(t.phi1, t.phi2);
        if (winner !== t.phi1 && winner !== t.phi2) {
          invalidAdjudications.push({
            kind: "invalid_adjudication",
            phi1: t.phi1,
            phi2: t.phi2,
            winner,
            reason: `policy returned winner "${winner}" which is not a party to the tension between "${t.phi1}" and "${t.phi2}"`,
            source: "auto",
          });
          return true;
        }
        const loser = winner === t.phi1 ? t.phi2 : t.phi1;
        if (!statePre.commitments.some((c) => c.type === "Prop" && c.phi === winner)) {
          statePre.commitments.push({ type: "Prop", phi: winner });
        }
        if (!statePre.rejected.includes(loser)) statePre.rejected.push(loser);
        contractBelief(statePre, loser);
        autoAdjudications.push({ phi1: t.phi1, phi2: t.phi2, winner });
        return false;
      }
      return true;
    });
  }

  const constraints = sortConstraints(
    mergeConstraints(effectiveInput.constraints ?? [], lift(residualPre))
  );
  const { stateNext, actionsCandidate, residualNew } = engine.run(
    statePre,
    constraints,
    effectiveProposals,
    residualPre
  );
  pruneMaterializedDeferred(residualNew, stateNext);
  const overflows = [...computeOverflows(residualNew, limits)].sort((left, right) =>
    stableSerialize(left).localeCompare(stableSerialize(right))
  );
  const { allowed, blocked } = filterBlocked(actionsCandidate, residualNew, stateNext);
  const allowedSorted = sortActions(allowed);
  const blockedSorted = sortActions(blocked);
  const idempotencyGate = applyIdempotencyGate({
    approvedActions: allowedSorted,
    blockedActions: blockedSorted,
    priorFingerprints: params.priorOperationFingerprints,
  });
  const approvedAfterIdempotency = idempotencyGate.approvedActions;
  const blockedAfterIdempotency = idempotencyGate.blockedActions;
  const escalations: EscalationEvent[] = sortEscalations(escalatedGaps.map((g) => ({
    kind: "escalation",
    phi: g.phi,
    stepsWithoutEvidence: g.stepsWithoutEvidence ?? 0,
    threshold: g.threshold,
  })));
  const deadlocks = [...computeDeadlocks(residualNew, dlThreshold)].sort((left, right) =>
    stableSerialize(left).localeCompare(stableSerialize(right))
  );
  const fingerprint = computeFingerprint(residualNew);
  const nextHistory = [...incomingHistory, fingerprint];
  const oscillations = [...detectOscillations(fingerprint, incomingHistory, oscWindow)].sort(
    (left, right) => stableSerialize(left).localeCompare(stableSerialize(right))
  );

  const { approvedWith, blockedWith } = buildCausalAnnotations(
    approvedAfterIdempotency,
    blockedAfterIdempotency,
    residualNew,
    stateNext,
    effectiveInput
  );
  const blockedWithIdempotency = [...blockedWith];
  for (const marker of idempotencyGate.blockedByMarkers) {
    const operationId = marker.split(":").at(-1);
    const action = blockedAfterIdempotency.find(
      (candidate) => candidate.operationId?.trim() === operationId
    );
    if (!action) continue;
    blockedWithIdempotency.push({
      action,
      blockedBy: [marker],
      enabledBy: [],
    });
  }

  const emittedRevocable = sortActions(approvedAfterIdempotency.filter((a) => a.revocable === true));
  const revokedActions = sortActions(
    priorRevocable.filter((a) => blocks(residualNew, stateNext, a))
  );
  const riskEscalations = buildRiskEscalations(blockedAfterIdempotency);
  const autoAdjudicationsSorted = [...autoAdjudications]
    .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
  const invalidAdjudicationsSorted = [...invalidAdjudications]
    .sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
  const reopenAppliedSorted = [...reopenPolicy.reopenApplied].sort((left, right) =>
    stableSerialize(left).localeCompare(stableSerialize(right))
  );
  const reopenBlockedSorted = [...reopenPolicy.reopenBlocked].sort((left, right) =>
    stableSerialize(left).localeCompare(stableSerialize(right))
  );
  const decisionHash = hashDecision({
    input,
    effectiveInput,
    constraints,
    candidateActions: sortActions(actionsCandidate),
    approvedActions: approvedAfterIdempotency,
    blockedActions: blockedAfterIdempotency,
    stateNext,
    residualNext: residualNew,
    escalations,
    overflows,
    deadlocks,
    oscillations,
    autoAdjudications: autoAdjudicationsSorted,
    invalidAdjudications: invalidAdjudicationsSorted,
    reopenApplied: reopenAppliedSorted,
    reopenBlocked: reopenBlockedSorted,
    idempotencyEvents: idempotencyGate.idempotencyEvents,
    emittedRevocable,
    revokedActions,
  });

  return {
    decisionHash,
    attestation: DEFAULT_REPLAY_ATTESTATION,
    stateNext: freezeIfTest(stateNext),
    residualNext: freezeIfTest(residualNew),
    actionsApproved: approvedAfterIdempotency,
    actionsBlocked: blockedAfterIdempotency,
    softBlocked: computeSoftBlocked(approvedAfterIdempotency, constraints),
    approvedWith,
    blockedWith: blockedWithIdempotency,
    escalations,
    overflows,
    oscillations,
    fingerprintHistory: nextHistory,
    autoAdjudications: autoAdjudicationsSorted,
    invalidAdjudications: invalidAdjudicationsSorted,
    reopenApplied: reopenAppliedSorted,
    reopenBlocked: reopenBlockedSorted,
    deadlocks,
    sessionArbitrationPolicy: NOOP_SESSION_ARBITRATION_POLICY,
    sessionConflicts: [],
    sessionArbitrations: [],
    riskEscalations,
    idempotencyEvents: idempotencyGate.idempotencyEvents,
    emittedRevocable,
    revokedActions,
    replay: {
      decisionHash,
      attestation: DEFAULT_REPLAY_ATTESTATION,
      input: deepClone(input),
      before: { state: beforeState, residual: beforeResidual },
      afterDischarge: { statePre: deepClone(statePre), residualPre: deepClone(residualPre) },
      constraints: deepClone(constraints),
      candidateActions: deepClone(sortActions(actionsCandidate)),
      approvedActions: deepClone(approvedAfterIdempotency),
      blockedActions: deepClone(blockedAfterIdempotency),
      ...(riskEscalations.length > 0
        ? { riskEscalations: deepClone(riskEscalations) }
        : {}),
      ...(idempotencyGate.idempotencyEvents.length > 0
        ? { idempotencyEvents: deepClone(idempotencyGate.idempotencyEvents) }
        : {}),
      ...(reopenAppliedSorted.length > 0 || reopenBlockedSorted.length > 0
        ? {
            reopen: {
              applied: deepClone(reopenAppliedSorted),
              blocked: deepClone(reopenBlockedSorted),
            },
          }
        : {}),
      after: { state: deepClone(stateNext), residual: deepClone(residualNew) },
    },
  };
}
