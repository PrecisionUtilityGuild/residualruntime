import { step } from "./engine";
import type {
  Action,
  Input,
  Proposal,
  ReplayAttestation,
  Residual,
  ReplayEvent,
  State,
  StepResult,
} from "./model";
import { translateTrace, verifyCcpTrace } from "./verify/ccp0";

export interface StepLogAdapter {
  append(event: ReplayEvent): void;
  readAll(): ReplayEvent[];
}

class InMemoryStepLog implements StepLogAdapter {
  private events: ReplayEvent[] = [];
  append(event: ReplayEvent): void { this.events.push(event); }
  readAll(): ReplayEvent[] { return [...this.events]; }
}

export function createInMemoryLog(): StepLogAdapter {
  return new InMemoryStepLog();
}

export function appendStep(log: StepLogAdapter, event: ReplayEvent): void {
  log.append(event);
}

export function readLog(log: StepLogAdapter): ReplayEvent[] {
  return log.readAll();
}

export class ReplayMismatchError extends Error {
  constructor(stepIndex: number, field: string, expected: unknown, actual: unknown) {
    super(
      `Replay mismatch at step ${stepIndex} — ${field}:\n` +
      `  expected: ${JSON.stringify(expected)}\n` +
      `  actual:   ${JSON.stringify(actual)}`
    );
    this.name = "ReplayMismatchError";
  }
}

export class CcpVerificationError extends Error {
  constructor(public readonly violations: string[]) {
    super(`CCP₀ verification failed:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
    this.name = "CcpVerificationError";
  }
}

function actionKey(a: Action): string {
  return JSON.stringify({
    type: a.type,
    operationId: a.operationId?.trim() || undefined,
    riskTier: a.riskTier ?? "medium",
    dependsOn: (a.dependsOn ?? []).slice().sort(),
    readSet: (a.readSet ?? []).slice().sort(),
    writeSet: (a.writeSet ?? []).slice().sort(),
  });
}

function serializeActions(actions: Action[]): string[] {
  return actions.map(actionKey).sort();
}

export function replayLog(
  log: StepLogAdapter,
  initialState: State,
  initialResidual: Residual,
  proposalSets: Proposal[][],
  options?: {
    ccpVerify?: boolean;
    stateVerify?: boolean;
    decisionVerify?: boolean;
    attestationMode?: "strict" | "compatible";
    expectedAttestation?: Partial<ReplayAttestation>;
  }
): StepResult[] {
  const events = log.readAll();
  if (events.length !== proposalSets.length) {
    throw new Error(
      `replayLog: log has ${events.length} events but ${proposalSets.length} proposal sets were provided`
    );
  }

  const results: StepResult[] = [];
  let state = initialState;
  let residual = initialResidual;

  const attestationMode = options?.attestationMode ?? "strict";

  for (let i = 0; i < events.length; i++) {
    const stored = events[i];
    const input: Input = stored.input;
    const proposals = proposalSets[i];

    const result = step({ state, residual, input, proposals });

    const expectedApproved = serializeActions(stored.approvedActions);
    const actualApproved = serializeActions(result.actionsApproved);
    if (JSON.stringify(expectedApproved) !== JSON.stringify(actualApproved)) {
      throw new ReplayMismatchError(i, "actionsApproved", expectedApproved, actualApproved);
    }

    const expectedBlocked = serializeActions(stored.blockedActions);
    const actualBlocked = serializeActions(result.actionsBlocked);
    if (JSON.stringify(expectedBlocked) !== JSON.stringify(actualBlocked)) {
      throw new ReplayMismatchError(i, "actionsBlocked", expectedBlocked, actualBlocked);
    }

    if (options?.decisionVerify) {
      if (!stored.decisionHash) {
        throw new ReplayMismatchError(i, "decisionHash", "present", undefined);
      }
      if (stored.decisionHash !== result.decisionHash) {
        throw new ReplayMismatchError(i, "decisionHash", stored.decisionHash, result.decisionHash);
      }
    }

    verifyAttestation({
      stepIndex: i,
      mode: attestationMode,
      expected: options?.expectedAttestation,
      stored: stored.attestation,
      actual: result.attestation,
    });

    if (options?.stateVerify) {
      const snap = stored.after.state;

      const expBelief = JSON.stringify(Object.fromEntries(Object.entries(snap.belief).sort()));
      const actBelief = JSON.stringify(Object.fromEntries(Object.entries(result.stateNext.belief).sort()));
      if (expBelief !== actBelief) {
        throw new ReplayMismatchError(i, "state.belief", snap.belief, result.stateNext.belief);
      }

      const expRejected = [...snap.rejected].sort();
      const actRejected = [...result.stateNext.rejected].sort();
      if (JSON.stringify(expRejected) !== JSON.stringify(actRejected)) {
        throw new ReplayMismatchError(i, "state.rejected", expRejected, actRejected);
      }

      const expCommitments = snap.commitments.map((c) => JSON.stringify(c)).sort();
      const actCommitments = result.stateNext.commitments.map((c) => JSON.stringify(c)).sort();
      if (JSON.stringify(expCommitments) !== JSON.stringify(actCommitments)) {
        throw new ReplayMismatchError(i, "state.commitments", expCommitments, actCommitments);
      }

      const expGapCounters = JSON.stringify(Object.fromEntries(Object.entries(snap.gapCounters).sort()));
      const actGapCounters = JSON.stringify(Object.fromEntries(Object.entries(result.stateNext.gapCounters).sort()));
      if (expGapCounters !== actGapCounters) {
        throw new ReplayMismatchError(i, "state.gapCounters", snap.gapCounters, result.stateNext.gapCounters);
      }

      const expBeliefSupport = JSON.stringify(
        Object.fromEntries(Object.entries(snap.beliefSupport).sort().map(([k, v]) => [k, [...v].sort()]))
      );
      const actBeliefSupport = JSON.stringify(
        Object.fromEntries(Object.entries(result.stateNext.beliefSupport).sort().map(([k, v]) => [k, [...v].sort()]))
      );
      if (expBeliefSupport !== actBeliefSupport) {
        throw new ReplayMismatchError(i, "state.beliefSupport", snap.beliefSupport, result.stateNext.beliefSupport);
      }
    }

    results.push(result);
    state = result.stateNext;
    residual = result.residualNext;
  }

  if (options?.ccpVerify) {
    const replayEvents = results.map((r) => r.replay);
    const { valid, violations } = verifyCcpTrace(translateTrace(replayEvents));
    if (!valid) throw new CcpVerificationError(violations);
  }

  return results;
}

function semverMajor(version: string): string {
  return version.split(".")[0] ?? version;
}

function verifyAttestation(params: {
  stepIndex: number;
  mode: "strict" | "compatible";
  expected?: Partial<ReplayAttestation>;
  stored?: ReplayAttestation;
  actual?: ReplayAttestation;
}): void {
  const { stepIndex, mode, expected, stored, actual } = params;
  if (!stored || !actual) {
    if (mode === "strict") {
      throw new ReplayMismatchError(stepIndex, "attestation", stored, actual);
    }
    return;
  }

  if (mode === "strict") {
    if (JSON.stringify(stored) !== JSON.stringify(actual)) {
      throw new ReplayMismatchError(stepIndex, "attestation", stored, actual);
    }
    if (expected) {
      const expectedMerged = { ...stored, ...expected };
      if (JSON.stringify(expectedMerged) !== JSON.stringify(stored)) {
        throw new ReplayMismatchError(stepIndex, "attestation.expected", expected, stored);
      }
    }
    return;
  }

  if (semverMajor(stored.runtimeVersion) !== semverMajor(actual.runtimeVersion)) {
    throw new ReplayMismatchError(
      stepIndex,
      "attestation.runtimeVersion.major",
      semverMajor(stored.runtimeVersion),
      semverMajor(actual.runtimeVersion)
    );
  }

  if (stored.schemaVersion !== actual.schemaVersion) {
    throw new ReplayMismatchError(
      stepIndex,
      "attestation.schemaVersion",
      stored.schemaVersion,
      actual.schemaVersion
    );
  }

  if (expected?.schemaVersion !== undefined && expected.schemaVersion !== stored.schemaVersion) {
    throw new ReplayMismatchError(
      stepIndex,
      "attestation.expected.schemaVersion",
      expected.schemaVersion,
      stored.schemaVersion
    );
  }
}
