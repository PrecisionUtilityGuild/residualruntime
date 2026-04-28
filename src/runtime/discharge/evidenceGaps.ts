import type { Deferred, EvidenceGap, Residual, State } from "../model";

export function dischargeEvidenceGaps(residual: Residual, state: State): EvidenceGap[] {
  const promotedDeferred: Deferred[] = [];
  const escalated: EvidenceGap[] = [];

  residual.evidenceGaps = residual.evidenceGaps.flatMap((gap) => {
    const belief = state.belief[gap.phi] ?? 0;
    if (belief >= gap.threshold) {
      delete state.gapCounters[gap.phi];
      return [];
    }

    const stepsWithoutEvidence = (gap.stepsWithoutEvidence ?? 0) + 1;
    const escalationSteps = gap.escalationSteps ?? 3;
    const updated = { ...gap, stepsWithoutEvidence, escalationSteps };

    state.gapCounters[gap.phi] = stepsWithoutEvidence;

    if (stepsWithoutEvidence >= escalationSteps) {
      escalated.push(updated);
      promotedDeferred.push({
        kind: "deferred",
        constraint: { type: "RequireEvidence", phi: gap.phi, threshold: gap.threshold },
        dependencies: [`evidence:${gap.phi}`],
        createdAt: gap.createdAt,
      });
      delete state.gapCounters[gap.phi];
      return [];
    }

    return [updated];
  });

  residual.deferred.push(...promotedDeferred);
  return escalated;
}
