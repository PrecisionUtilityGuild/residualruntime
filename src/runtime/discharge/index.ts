import type { EvidenceGap, InvalidAdjudicationEvent, Input, Residual, State } from "../model";
import { dischargeAssumptions } from "./assumptions";
import { dischargeDeferred } from "./deferred";
import { dischargeEvidenceGaps } from "./evidenceGaps";
import { dischargeTensions } from "./tensions";

export function applyEvidence(state: State, input: Input): void {
  const evidence = input.evidence ?? {};
  for (const [phi, mass] of Object.entries(evidence)) {
    state.belief[phi] = Math.max(state.belief[phi] ?? 0, mass);
    // Evidence entries are ground facts: self-supported.
    if (!state.beliefSupport[phi]) state.beliefSupport[phi] = [phi];
  }
}

export function dischargeAll(
  residual: Residual,
  state: State,
  input: Input
): { escalated: EvidenceGap[]; invalidAdjudications: InvalidAdjudicationEvent[] } {
  applyEvidence(state, input);
  dischargeAssumptions(residual, state);
  const escalated = dischargeEvidenceGaps(residual, state);
  const invalidAdjudications = dischargeTensions(residual, input, state);
  dischargeDeferred(residual, state);
  return { escalated, invalidAdjudications };
}
