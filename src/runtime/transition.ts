import { createEmptyResidual, type Action, type Constraint, type Proposal, type Residual, type State } from "./model";

export type PreferenceMap = Map<string, number>;

export interface TransitionEngine {
  run(
    statePre: State,
    constraints: Constraint[],
    proposals: Proposal[],
    residualPre?: Residual
  ): { stateNext: State; actionsCandidate: Action[]; residualNew: Residual };
}

export class DefaultTransitionEngine implements TransitionEngine {
  run(
    statePre: State,
    constraints: Constraint[],
    proposals: Proposal[],
    residualPre?: Residual
  ): { stateNext: State; actionsCandidate: Action[]; residualNew: Residual } {
    const stateNext: State = JSON.parse(JSON.stringify(statePre));
    const actionsCandidate: Action[] = [];
    const residualNew = createEmptyResidual();

    for (const c of constraints) {
      if (c.type === "Prop") {
        if (!stateNext.commitments.some((k) => k.type === "Prop" && k.phi === c.phi)) {
          stateNext.commitments.push({ type: "Prop", phi: c.phi });
          // Ground fact: belief entry for this phi is self-supported.
          if (stateNext.belief[c.phi] !== undefined && !stateNext.beliefSupport[c.phi]) {
            stateNext.beliefSupport[c.phi] = [c.phi];
          }
        }
      } else if (c.type === "Unresolved") {
        if (c.phi1 === c.phi2) continue;
        const key = [c.phi1, c.phi2].sort().join("\0");
        const prior = residualPre?.tensions.find(
          (t) => [t.phi1, t.phi2].sort().join("\0") === key
        );
        residualNew.tensions.push({
          kind: "tension",
          phi1: c.phi1,
          phi2: c.phi2,
          stepsAlive: prior?.stepsAlive,
          createdAt: prior?.createdAt ?? Date.now(),
        });
      } else if (c.type === "RequireEvidence") {
        const belief = stateNext.belief[c.phi] ?? 0;
        if (belief < c.threshold) {
          const existing = residualPre?.evidenceGaps.find((g) => g.phi === c.phi);
          residualNew.evidenceGaps.push({
            kind: "evidence_gap",
            phi: c.phi,
            threshold: c.threshold,
            escalationSteps: existing?.escalationSteps ?? 3,
            stepsWithoutEvidence: existing?.stepsWithoutEvidence ?? (stateNext.gapCounters?.[c.phi] ?? 0),
            createdAt: existing?.createdAt ?? Date.now(),
          });
        }
      }
    }

    // Carry forward surviving assumptions and stuck deferred items from residualPre
    if (residualPre) {
      for (const a of residualPre.assumptions) {
        residualNew.assumptions.push(a);
      }
      for (const d of residualPre.deferred) {
        residualNew.deferred.push(d);
      }
    }

    for (const p of proposals) {
      switch (p.kind) {
        case "action":
          actionsCandidate.push(p);
          break;
        case "assumption":
          if (!residualNew.assumptions.some((a) => a === p || a.phi === p.phi)) {
            residualNew.assumptions.push({ ...p, createdAt: p.createdAt ?? Date.now() });
          }
          break;
        case "deferred":
          // Only add if not already carried from residualPre
          if (!residualNew.deferred.some((d) => d === p)) {
            residualNew.deferred.push({ ...p, createdAt: p.createdAt ?? Date.now() });
          }
          break;
        case "tension":
          residualNew.tensions.push({ ...p, createdAt: p.createdAt ?? Date.now() });
          break;
        case "evidence_gap":
          residualNew.evidenceGaps.push({ ...p, createdAt: p.createdAt ?? Date.now() });
          break;
      }
    }

    return { stateNext, actionsCandidate, residualNew };
  }
}

export function transition(
  statePre: State,
  constraints: Constraint[],
  proposals: Proposal[],
  residualPre?: Residual
): { stateNext: State; actionsCandidate: Action[]; residualNew: Residual } {
  return new DefaultTransitionEngine().run(statePre, constraints, proposals, residualPre);
}
