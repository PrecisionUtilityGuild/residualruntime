/**
 * CCP₀ Re-encoding of Residual Runtime Traces
 *
 * The residual runtime is a concurrent constraint programming (CCP) system in
 * the sense of Saraswat & Rinard (POPL 1990). CCP₀ is the core fragment:
 *
 *   tell(c): add constraint c to the store (monotone — never retracted).
 *   ask(c):  proceed only if c is entailed by the current store; otherwise
 *            suspend (the ask blocks).
 *
 * The correspondence to the residual runtime:
 *   - The constraint *store* is the set of committed atoms in state.commitments
 *     plus the winner atoms of each adjudication recorded in state.rejected's
 *     complement.
 *   - An approved action A with dependsOn=[φ] corresponds to tell(φ) after a
 *     successful ask(φ): the store already entails φ (or no constraint prevents
 *     it), so the action fires.
 *   - A blocked action A with dependsOn=[φ] corresponds to a failed ask(φ):
 *     the store does not yet entail φ (tension open, evidence gap, or φ
 *     rejected), so A suspends.
 *   - Adjudication (winner=φ) corresponds to tell(φ) entering the store and
 *     permanently foreclosing the loser.
 *
 * Monotonicity invariant: once an atom is committed (told), it is never
 * retracted. The "rejected" list enforces the dual: once an atom is foreclosed,
 * ask(φ) on it will always fail.
 */

import type { ReplayEvent } from "../model";

// ── CCP₀ types ────────────────────────────────────────────────────────────────

/** A monotone constraint store: maps atoms to presence (true = told). */
export type CcpStore = Set<string>;

/** A tell operation: add atom to the store. */
export type TellOp = { kind: "tell"; phi: string; stepIndex: number };

/** An ask operation: check if atom is in the store before an action fires. */
export type AskOp = {
  kind: "ask";
  phi: string;
  stepIndex: number;
  /** Whether the ask succeeded (atom was in store at evaluation time). */
  succeeded: boolean;
  /** The action label this ask guards. */
  actionType: string;
};

export type CcpOp = TellOp | AskOp;

export type CcpTrace = {
  ops: CcpOp[];
  finalStore: CcpStore;
};

// ── Translation ───────────────────────────────────────────────────────────────

/**
 * Translate a sequence of ReplayEvents into a CCP₀ trace.
 *
 * Approved actions → ask(phi) succeeded + tell(phi) for each dependsOn atom
 * Blocked actions  → ask(phi) failed for each dependsOn atom
 * Adjudications    → tell(winner) into the store
 */
export function translateTrace(events: ReplayEvent[]): CcpTrace {
  const store: CcpStore = new Set();
  const ops: CcpOp[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // Adjudications: tell(winner) — winner atom enters the store monotonically.
    for (const adj of event.input.adjudications ?? []) {
      if (!store.has(adj.winner)) {
        store.add(adj.winner);
        ops.push({ kind: "tell", phi: adj.winner, stepIndex: i });
      }
    }

    // Blocked actions: failed ask(phi) for each blocking dependsOn atom.
    for (const action of event.blockedActions) {
      for (const phi of action.dependsOn ?? []) {
        if (!store.has(phi)) {
          ops.push({ kind: "ask", phi, stepIndex: i, succeeded: false, actionType: action.type });
        }
      }
    }

    // Approved actions: successful ask(phi) + tell(phi) for each dependsOn atom.
    for (const action of event.approvedActions) {
      for (const phi of action.dependsOn ?? []) {
        ops.push({ kind: "ask", phi, stepIndex: i, succeeded: true, actionType: action.type });
        // Approved execution tells the phi into the store (action fired, fact committed).
        if (!store.has(phi)) {
          store.add(phi);
          ops.push({ kind: "tell", phi, stepIndex: i });
        }
      }
    }
  }

  return { ops, finalStore: store };
}

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify a CCP₀ trace for:
 * 1. Monotonicity: no tell(phi) appears twice (store is append-only).
 * 2. Consistency: every ask(phi, succeeded=false) corresponds to a phi that
 *    was not yet in the store at that step.
 * 3. Completeness: every ask(phi, succeeded=true) corresponds to a phi that
 *    was in the store (or told in the same step) at evaluation time.
 */
export function verifyCcpTrace(trace: CcpTrace): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  const toldAt = new Map<string, number>(); // phi → stepIndex first told
  const storeAt: Array<Set<string>> = []; // store snapshot after each op group by step

  // Replay tells in order to reconstruct per-step store state.
  const stepsPresent = new Set(trace.ops.map((op) => op.stepIndex));
  const maxStep = stepsPresent.size === 0 ? 0 : Math.max(...stepsPresent);

  const runningStore = new Set<string>();
  const storeByStep = new Map<number, Set<string>>();

  for (let step = 0; step <= maxStep; step++) {
    const tells = trace.ops.filter((op): op is TellOp => op.kind === "tell" && op.stepIndex === step);
    for (const tell of tells) {
      if (toldAt.has(tell.phi)) {
        violations.push(`Monotonicity violation: tell(${tell.phi}) at step ${step} but already told at step ${toldAt.get(tell.phi)}`);
      } else {
        toldAt.set(tell.phi, step);
        runningStore.add(tell.phi);
      }
    }
    storeByStep.set(step, new Set(runningStore));
  }

  // Verify asks against the store that existed at their step.
  for (const op of trace.ops) {
    if (op.kind !== "ask") continue;
    const storeAtStep = storeByStep.get(op.stepIndex) ?? new Set<string>();
    const inStore = storeAtStep.has(op.phi);
    if (op.succeeded && !inStore) {
      violations.push(`Ask consistency: ask(${op.phi}) marked succeeded at step ${op.stepIndex} but phi not in store`);
    }
    if (!op.succeeded && inStore) {
      violations.push(`Ask consistency: ask(${op.phi}) marked failed at step ${op.stepIndex} but phi was in store`);
    }
  }

  // Unused — kept for type alignment
  void storeAt;

  return { valid: violations.length === 0, violations };
}
