import { step } from "./engine";
import type { Action, Input, Proposal, Residual, ReplayEvent, State, StepResult } from "./model";
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
  return JSON.stringify({ type: a.type, dependsOn: (a.dependsOn ?? []).slice().sort() });
}

function serializeActions(actions: Action[]): string[] {
  return actions.map(actionKey).sort();
}

export function replayLog(
  log: StepLogAdapter,
  initialState: State,
  initialResidual: Residual,
  proposalSets: Proposal[][],
  options?: { ccpVerify?: boolean; stateVerify?: boolean }
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
