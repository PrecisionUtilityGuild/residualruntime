import type { Action, Assumption, EvidenceGap, ReplayEvent, Tension } from "./model";
import { translateTrace, verifyCcpTrace } from "./verify/ccp0";

export type StepDiff = {
  tensionsAdded: Tension[];
  tensionsRemoved: Tension[];
  evidenceGapsAdded: EvidenceGap[];
  evidenceGapsRemoved: EvidenceGap[];
  assumptionsAdded: Assumption[];
  assumptionsRetracted: Assumption[];
  actionsApproved: Action[];
  actionsBlocked: Action[];
};

export type StepMetrics = {
  totalSteps: number;
  totalActionsApproved: number;
  totalActionsBlocked: number;
  blockedRate: number;
  avgResidualSize: number;
  peakResidualSize: number;
};

function tensionKey(t: Tension): string {
  return [t.phi1, t.phi2].sort().join("\0");
}

export function diffStep(before: ReplayEvent, after: ReplayEvent): StepDiff {
  const beforeResidual = before.after.residual;
  const afterResidual = after.after.residual;

  const beforeTensionKeys = new Set(beforeResidual.tensions.map(tensionKey));
  const afterTensionKeys = new Set(afterResidual.tensions.map(tensionKey));
  const tensionsAdded = afterResidual.tensions.filter((t) => !beforeTensionKeys.has(tensionKey(t)));
  const tensionsRemoved = beforeResidual.tensions.filter((t) => !afterTensionKeys.has(tensionKey(t)));

  const beforeGapPhis = new Set(beforeResidual.evidenceGaps.map((g) => g.phi));
  const afterGapPhis = new Set(afterResidual.evidenceGaps.map((g) => g.phi));
  const evidenceGapsAdded = afterResidual.evidenceGaps.filter((g) => !beforeGapPhis.has(g.phi));
  const evidenceGapsRemoved = beforeResidual.evidenceGaps.filter((g) => !afterGapPhis.has(g.phi));

  const beforeAssumptionPhis = new Set(beforeResidual.assumptions.map((a) => a.phi));
  const afterAssumptionPhis = new Set(afterResidual.assumptions.map((a) => a.phi));
  const assumptionsAdded = afterResidual.assumptions.filter((a) => !beforeAssumptionPhis.has(a.phi));
  const assumptionsRetracted = beforeResidual.assumptions.filter((a) => !afterAssumptionPhis.has(a.phi));

  return {
    tensionsAdded,
    tensionsRemoved,
    evidenceGapsAdded,
    evidenceGapsRemoved,
    assumptionsAdded,
    assumptionsRetracted,
    actionsApproved: after.approvedActions,
    actionsBlocked: after.blockedActions,
  };
}

function residualSize(event: ReplayEvent): number {
  const r = event.after.residual;
  return r.tensions.length + r.evidenceGaps.length + r.deferred.length + r.assumptions.length;
}

export function computeMetrics(events: ReplayEvent[]): StepMetrics {
  if (events.length === 0) {
    return { totalSteps: 0, totalActionsApproved: 0, totalActionsBlocked: 0, blockedRate: 0, avgResidualSize: 0, peakResidualSize: 0 };
  }

  let totalActionsApproved = 0;
  let totalActionsBlocked = 0;
  let totalResidualSize = 0;
  let peakResidualSize = 0;

  for (const event of events) {
    totalActionsApproved += event.approvedActions.length;
    totalActionsBlocked += event.blockedActions.length;
    const size = residualSize(event);
    totalResidualSize += size;
    if (size > peakResidualSize) peakResidualSize = size;
  }

  const total = totalActionsApproved + totalActionsBlocked;
  const blockedRate = total === 0 ? 0 : totalActionsBlocked / total;

  return {
    totalSteps: events.length,
    totalActionsApproved,
    totalActionsBlocked,
    blockedRate,
    avgResidualSize: totalResidualSize / events.length,
    peakResidualSize,
  };
}

export function summarizeTrace(events: ReplayEvent[]): string {
  const m = computeMetrics(events);
  const blockedPct = (m.blockedRate * 100).toFixed(1);
  const lines: string[] = [
    `Steps: ${m.totalSteps} | Approved: ${m.totalActionsApproved} | Blocked: ${m.totalActionsBlocked} | Blocked rate: ${blockedPct}% | Peak residual: ${m.peakResidualSize}`,
  ];

  const allBlocked = events.flatMap((e) => e.blockedActions.map((a) => a.type));
  if (allBlocked.length > 0) {
    lines.push(`Blocked actions: ${[...new Set(allBlocked)].join(", ")}`);
  }

  const rejectedAtoms = events.flatMap((e) => e.after.state.rejected);
  if (rejectedAtoms.length > 0) {
    lines.push(`Permanent rejections: ${[...new Set(rejectedAtoms)].join(", ")}`);
  }

  if (events.length > 0) {
    const { valid, violations } = verifyCcpTrace(translateTrace(events));
    if (valid) {
      lines.push(`CCP₀ verification: PASS`);
    } else {
      lines.push(`CCP₀ verification: FAIL (${violations.length} violation(s): ${violations[0]}${violations.length > 1 ? " …" : ""})`);
    }
  }

  return lines.join("\n");
}
