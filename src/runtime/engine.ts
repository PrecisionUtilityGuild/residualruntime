import { dischargeAll } from "./discharge";
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
  type Input,
  type Proposal,
  type ReopenAppliedEvent,
  type ReopenBlockedEvent,
  type ReopenSignal,
  type Residual,
  type ResidualLimits,
  type SessionArbitrationPolicy,
  type State,
  type StepResult,
  type TensionTimeoutPolicy,
} from "./model";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const NOOP_SESSION_ARBITRATION_POLICY: SessionArbitrationPolicy = {
  enabled: false,
  defaultMode: "serialize_first",
  modeByConflictType: {},
  objectiveTypePriority: {},
};

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
  const constraints = mergeConstraints(input.constraints ?? [], lift(residualPre));
  const { stateNext, actionsCandidate, residualNew } = engine.run(statePre, constraints, proposals, residualPre);
  pruneMaterializedDeferred(residualNew, stateNext);
  const escalations: EscalationEvent[] = escalatedGaps.map((g) => ({
    kind: "escalation",
    phi: g.phi,
    stepsWithoutEvidence: g.stepsWithoutEvidence ?? 0,
    threshold: g.threshold,
  }));

  return {
    stateNext: freezeIfTest(stateNext),
    residualNext: freezeIfTest(residualNew),
    actionsApproved: actionsCandidate,
    actionsBlocked: [],
    softBlocked: computeSoftBlocked(actionsCandidate, constraints),
    approvedWith: [],
    blockedWith: [],
    escalations,
    overflows: [],
    oscillations: [],
    fingerprintHistory: [],
    autoAdjudications: [],
    invalidAdjudications,
    reopenApplied: [],
    reopenBlocked: [],
    deadlocks: [],
    sessionArbitrationPolicy: NOOP_SESSION_ARBITRATION_POLICY,
    sessionConflicts: [],
    sessionArbitrations: [],
    emittedRevocable: actionsCandidate.filter((a) => a.revocable === true),
    revokedActions: [],
    replay: {
      input: deepClone(input),
      before: { state: beforeState, residual: beforeResidual },
      afterDischarge: { statePre: deepClone(statePre), residualPre: deepClone(residualPre) },
      constraints: deepClone(constraints),
      candidateActions: deepClone(actionsCandidate),
      approvedActions: deepClone(actionsCandidate),
      blockedActions: [],
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

  const constraints = mergeConstraints(effectiveInput.constraints ?? [], lift(residualPre));
  const { stateNext, actionsCandidate, residualNew } = engine.run(
    statePre,
    constraints,
    effectiveProposals,
    residualPre
  );
  pruneMaterializedDeferred(residualNew, stateNext);
  const overflows = computeOverflows(residualNew, limits);
  const { allowed, blocked } = filterBlocked(actionsCandidate, residualNew, stateNext);
  const escalations: EscalationEvent[] = escalatedGaps.map((g) => ({
    kind: "escalation",
    phi: g.phi,
    stepsWithoutEvidence: g.stepsWithoutEvidence ?? 0,
    threshold: g.threshold,
  }));
  const deadlocks = computeDeadlocks(residualNew, dlThreshold);
  const fingerprint = computeFingerprint(residualNew);
  const nextHistory = [...incomingHistory, fingerprint];
  const oscillations = detectOscillations(fingerprint, incomingHistory, oscWindow);

  const { approvedWith, blockedWith } = buildCausalAnnotations(
    allowed,
    blocked,
    residualNew,
    stateNext,
    effectiveInput
  );

  const emittedRevocable = allowed.filter((a) => a.revocable === true);
  const revokedActions = priorRevocable.filter((a) => blocks(residualNew, stateNext, a));

  return {
    stateNext: freezeIfTest(stateNext),
    residualNext: freezeIfTest(residualNew),
    actionsApproved: allowed,
    actionsBlocked: blocked,
    softBlocked: computeSoftBlocked(allowed, constraints),
    approvedWith,
    blockedWith,
    escalations,
    overflows,
    oscillations,
    fingerprintHistory: nextHistory,
    autoAdjudications,
    invalidAdjudications,
    reopenApplied: reopenPolicy.reopenApplied,
    reopenBlocked: reopenPolicy.reopenBlocked,
    deadlocks,
    sessionArbitrationPolicy: NOOP_SESSION_ARBITRATION_POLICY,
    sessionConflicts: [],
    sessionArbitrations: [],
    emittedRevocable,
    revokedActions,
    replay: {
      input: deepClone(input),
      before: { state: beforeState, residual: beforeResidual },
      afterDischarge: { statePre: deepClone(statePre), residualPre: deepClone(residualPre) },
      constraints: deepClone(constraints),
      candidateActions: deepClone(actionsCandidate),
      approvedActions: deepClone(allowed),
      blockedActions: deepClone(blocked),
      ...(reopenPolicy.reopenApplied.length > 0 || reopenPolicy.reopenBlocked.length > 0
        ? {
            reopen: {
              applied: deepClone(reopenPolicy.reopenApplied),
              blocked: deepClone(reopenPolicy.reopenBlocked),
            },
          }
        : {}),
      after: { state: deepClone(stateNext), residual: deepClone(residualNew) },
    },
  };
}
