import type {
  Action,
  AcquisitionMove,
  BlockerCertificate,
  Residual,
  ResidualDelta,
  State,
  UnblockAnalysis,
} from "./model";
import { constraintIsEffectivelyMaterialized } from "./deferredState";

export function blocks(residual: Residual, state: State, action: Action): boolean {
  const deps = action.dependsOn ?? [];

  if (residual.tensions.some((t) => deps.includes(t.phi1) || deps.includes(t.phi2))) return true;
  if (residual.evidenceGaps.some((g) => deps.includes(g.phi))) return true;
  if (state.rejected.some((r) => deps.includes(r))) return true;

  return residual.deferred.some((d) => {
    if (constraintIsEffectivelyMaterialized(d.constraint, residual, state)) return false;
    const c = d.constraint;
    let atoms: string[] = [];
    if (c.type === "RequireEvidence") atoms = [c.phi];
    else if (c.type === "Prop") atoms = [c.phi];
    else if (c.type === "Unresolved") atoms = [c.phi1, c.phi2];
    return atoms.some((a) => deps.includes(a));
  });
}

export function blockingAtoms(residual: Residual, state: State, action: Action): string[] {
  const deps = action.dependsOn ?? [];
  const atoms: string[] = [];

  for (const t of residual.tensions) {
    if (deps.includes(t.phi1)) atoms.push(t.phi1);
    if (deps.includes(t.phi2)) atoms.push(t.phi2);
  }
  for (const g of residual.evidenceGaps) {
    if (deps.includes(g.phi)) atoms.push(g.phi);
  }
  for (const r of state.rejected) {
    if (deps.includes(r)) atoms.push(r);
  }
  for (const d of residual.deferred) {
    if (constraintIsEffectivelyMaterialized(d.constraint, residual, state)) continue;
    const c = d.constraint;
    let dAtoms: string[] = [];
    if (c.type === "RequireEvidence") dAtoms = [c.phi];
    else if (c.type === "Prop") dAtoms = [c.phi];
    else if (c.type === "Unresolved") dAtoms = [c.phi1, c.phi2];
    for (const a of dAtoms) {
      if (deps.includes(a)) atoms.push(a);
    }
  }
  return [...new Set(atoms)];
}

type DeltaCandidate =
  | { kind: "adjudicate-tension"; phi1: string; phi2: string; winner: string }
  | { kind: "satisfy-evidence-gap"; phi: string; requiredBelief: number }
  | { kind: "commit-deferred-dependency"; phi: string };

function applyDelta(delta: DeltaCandidate, residual: Residual, state: State): { residual: Residual; state: State } {
  const r: Residual = { ...residual, tensions: [...residual.tensions], evidenceGaps: [...residual.evidenceGaps], deferred: [...residual.deferred], assumptions: [...residual.assumptions] };
  const s: State = { ...state, belief: { ...state.belief }, rejected: [...state.rejected] };

  if (delta.kind === "adjudicate-tension") {
    const loser = delta.winner === delta.phi1 ? delta.phi2 : delta.phi1;
    r.tensions = r.tensions.filter((t) => !(t.phi1 === delta.phi1 && t.phi2 === delta.phi2));
    s.belief[delta.winner] = Math.max(s.belief[delta.winner] ?? 0, 1);
    if (!s.rejected.includes(loser)) s.rejected = [...s.rejected, loser];
  } else if (delta.kind === "satisfy-evidence-gap") {
    r.evidenceGaps = r.evidenceGaps.filter((g) => g.phi !== delta.phi);
    s.belief[delta.phi] = Math.max(s.belief[delta.phi] ?? 0, delta.requiredBelief);
  } else if (delta.kind === "commit-deferred-dependency") {
    r.deferred = r.deferred.filter((d) => {
      const c = d.constraint;
      if (c.type === "Prop") return c.phi !== delta.phi;
      if (c.type === "RequireEvidence") return c.phi !== delta.phi;
      if (c.type === "Unresolved") return c.phi1 !== delta.phi && c.phi2 !== delta.phi;
      return true;
    });
  }

  return { residual: r, state: s };
}

function unresolvedKey(phi1: string, phi2: string): string {
  return [phi1, phi2].sort().join("\0");
}

function dedupeMoves(moves: AcquisitionMove[]): AcquisitionMove[] {
  const seen = new Set<string>();
  const deduped: AcquisitionMove[] = [];
  for (const move of moves) {
    const key = `${move.kind}|${move.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(move);
  }
  return deduped;
}

function rejectedRecommendations(rejectedAtoms: string[]): AcquisitionMove[] {
  const scope = rejectedAtoms.slice().sort().join("|");
  return [
    {
      kind: "query",
      target: `plan:alternatives:${scope}`,
      reason: "Select an alternate plan that avoids permanently rejected atoms.",
    },
  ];
}

function tensionRecommendations(phi1: string, phi2: string): AcquisitionMove[] {
  const pair = [phi1, phi2].sort().join("|");
  return [
    {
      kind: "query",
      target: `source-of-truth:${pair}`,
      reason: "Gather authoritative evidence to adjudicate the open tension.",
    },
    {
      kind: "observe",
      target: `adjudication:${pair}`,
      reason: "Watch for adjudication updates when another actor owns the decision.",
    },
  ];
}

function evidenceGapRecommendations(phi: string): AcquisitionMove[] {
  return [
    {
      kind: "run_check",
      target: `evidence:${phi}`,
      reason: "Run the relevant check to raise belief on the required atom.",
    },
    {
      kind: "query",
      target: `evidence:${phi}`,
      reason: "Query existing systems for already-produced evidence before re-running checks.",
    },
  ];
}

function deferredRecommendations(atom: string, constraintKinds: Set<string>): AcquisitionMove[] {
  const moves: AcquisitionMove[] = [];
  if (constraintKinds.has("Prop")) {
    moves.push({
      kind: "request_approval",
      target: `approval:${atom}`,
      reason: "Request the missing approval/commitment required for this dependency.",
    });
  }
  if (constraintKinds.has("RequireEvidence")) {
    moves.push({
      kind: "run_check",
      target: `evidence:${atom}`,
      reason: "Produce the evidence needed to satisfy the deferred dependency.",
    });
  }
  if (constraintKinds.has("Unresolved")) {
    moves.push({
      kind: "query",
      target: `dependency:${atom}`,
      reason: "Query which unresolved branch should be committed to discharge this dependency.",
    });
  }
  if (moves.length === 0) {
    moves.push({
      kind: "query",
      target: `dependency:${atom}`,
      reason: "Query dependency state to identify the next unblockable commit.",
    });
  }
  moves.push({
    kind: "observe",
    target: `dependency:${atom}`,
    reason: "Observe for upstream dependency resolution if another actor controls it.",
  });
  return dedupeMoves(moves);
}

function blockerOwnership(args: {
  blockerType: BlockerCertificate["blockerType"];
  ownerRef: string;
}): BlockerCertificate["ownership"] {
  switch (args.blockerType) {
    case "epistemic_rejected":
      return {
        ownerRole: "planner",
        ownerRef: args.ownerRef,
        sla: {
          targetMs: 60 * 60 * 1000,
          escalationTarget: "human_review",
          escalationMessage:
            "Permanent rejected atom requires explicit replan approval from planner/maintainer.",
        },
      };
    case "epistemic_tension":
      return {
        ownerRole: "arbiter",
        ownerRef: args.ownerRef,
        sla: {
          targetMs: 30 * 60 * 1000,
          escalationTarget: "human_review",
          escalationMessage:
            "Open tension exceeded adjudication SLA; escalate to human arbiter.",
        },
      };
    case "epistemic_evidence_gap":
      return {
        ownerRole: "evidence_provider",
        ownerRef: args.ownerRef,
        sla: {
          targetMs: 45 * 60 * 1000,
          escalationTarget: "incident_channel",
          escalationMessage:
            "Evidence gap unresolved within SLA; escalate to evidence-producing team.",
        },
      };
    case "epistemic_deferred":
      return {
        ownerRole: "approver",
        ownerRef: args.ownerRef,
        sla: {
          targetMs: 2 * 60 * 60 * 1000,
          escalationTarget: "human_review",
          escalationMessage:
            "Deferred dependency remained unresolved past approval SLA; escalate approver chain.",
        },
      };
    case "session_coordination":
      return {
        ownerRole: "session_owner",
        ownerRef: args.ownerRef,
        sla: {
          targetMs: 15 * 60 * 1000,
          escalationTarget: "session_coordination",
          escalationMessage:
            "Cross-session coordination conflict exceeded SLA; trigger explicit session coordination.",
        },
      };
  }
}

export function whatWouldUnblock(
  action: Action,
  residual: Residual,
  state: State
): UnblockAnalysis {
  const deps = action.dependsOn ?? [];

  // Permanently blocked: a rejected atom can never be un-rejected.
  if (deps.some((d) => state.rejected.includes(d))) return { permanent: true, deltas: [] };

  const candidates: DeltaCandidate[] = [];
  const seen = new Set<string>();

  const add = (key: string, delta: DeltaCandidate) => {
    if (!seen.has(key)) { seen.add(key); candidates.push(delta); }
  };

  for (const t of residual.tensions) {
    if (deps.includes(t.phi1) || deps.includes(t.phi2)) {
      add(`tension:${t.phi1}:${t.phi2}:${t.phi1}`, { kind: "adjudicate-tension", phi1: t.phi1, phi2: t.phi2, winner: t.phi1 });
      add(`tension:${t.phi1}:${t.phi2}:${t.phi2}`, { kind: "adjudicate-tension", phi1: t.phi1, phi2: t.phi2, winner: t.phi2 });
    }
  }

  for (const g of residual.evidenceGaps) {
    if (deps.includes(g.phi)) {
      add(`gap:${g.phi}`, { kind: "satisfy-evidence-gap", phi: g.phi, requiredBelief: g.threshold });
    }
  }

  for (const d of residual.deferred) {
    if (constraintIsEffectivelyMaterialized(d.constraint, residual, state)) continue;
    const c = d.constraint;
    let dAtoms: string[] = [];
    if (c.type === "Prop") dAtoms = [c.phi];
    else if (c.type === "RequireEvidence") dAtoms = [c.phi];
    else if (c.type === "Unresolved") dAtoms = [c.phi1, c.phi2];
    for (const a of dAtoms) {
      if (deps.includes(a)) {
        add(`deferred:${a}`, { kind: "commit-deferred-dependency", phi: a });
      }
    }
  }

  const deltas = candidates.map((delta) => {
    const { residual: r, state: s } = applyDelta(delta, residual, state);
    return { ...delta, sufficient: !blocks(r, s, action) } as ResidualDelta;
  });

  return { permanent: false, deltas };
}

export function blockerCertificates(
  action: Action,
  residual: Residual,
  state: State
): BlockerCertificate[] {
  const deps = action.dependsOn ?? [];
  const rejectedAtoms = [...new Set(deps.filter((dep) => state.rejected.includes(dep)))].sort();
  if (rejectedAtoms.length > 0) {
    return [
      {
        blockerId: `rejected:${rejectedAtoms.join("|")}`,
        blockerType: "epistemic_rejected",
        atoms: rejectedAtoms,
        permanent: true,
        sufficient: true,
        ownership: blockerOwnership({
          blockerType: "epistemic_rejected",
          ownerRef: `planner:${rejectedAtoms.join("|")}`,
        }),
        recommendations: {
          semantics: "advisory",
          moves: rejectedRecommendations(rejectedAtoms),
        },
        next: {
          kind: "replan_without_rejected_atom",
          rejectedAtoms,
        },
      },
    ];
  }

  const certificates: BlockerCertificate[] = [];

  const seenTensions = new Set<string>();
  for (const tension of residual.tensions) {
    if (!deps.includes(tension.phi1) && !deps.includes(tension.phi2)) continue;

    const pairKey = unresolvedKey(tension.phi1, tension.phi2);
    if (seenTensions.has(pairKey)) continue;
    seenTensions.add(pairKey);

    const options = [tension.phi1, tension.phi2].map((winner) => {
      const delta: DeltaCandidate = {
        kind: "adjudicate-tension",
        phi1: tension.phi1,
        phi2: tension.phi2,
        winner,
      };
      const after = applyDelta(delta, residual, state);
      return {
        winner,
        sufficient: !blocks(after.residual, after.state, action),
      };
    });

    certificates.push({
      blockerId: `tension:${[tension.phi1, tension.phi2].sort().join("|")}`,
      blockerType: "epistemic_tension",
      atoms: [tension.phi1, tension.phi2].filter((atom) => deps.includes(atom)),
      permanent: false,
      sufficient: options.some((option) => option.sufficient),
      ownership: blockerOwnership({
        blockerType: "epistemic_tension",
        ownerRef: `arbiter:${[tension.phi1, tension.phi2].sort().join("|")}`,
      }),
      recommendations: {
        semantics: "advisory",
        moves: tensionRecommendations(tension.phi1, tension.phi2),
      },
      next: {
        kind: "adjudicate_tension",
        phi1: tension.phi1,
        phi2: tension.phi2,
        options,
      },
    });
  }

  const maxThresholdByPhi = new Map<string, number>();
  for (const gap of residual.evidenceGaps) {
    if (!deps.includes(gap.phi)) continue;
    const prev = maxThresholdByPhi.get(gap.phi) ?? Number.NEGATIVE_INFINITY;
    maxThresholdByPhi.set(gap.phi, Math.max(prev, gap.threshold));
  }

  for (const [phi, threshold] of [...maxThresholdByPhi.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const delta: DeltaCandidate = {
      kind: "satisfy-evidence-gap",
      phi,
      requiredBelief: threshold,
    };
    const after = applyDelta(delta, residual, state);
    certificates.push({
      blockerId: `evidence_gap:${phi}`,
      blockerType: "epistemic_evidence_gap",
      atoms: [phi],
      permanent: false,
      sufficient: !blocks(after.residual, after.state, action),
      ownership: blockerOwnership({
        blockerType: "epistemic_evidence_gap",
        ownerRef: `evidence:${phi}`,
      }),
      recommendations: {
        semantics: "advisory",
        moves: evidenceGapRecommendations(phi),
      },
      next: {
        kind: "provide_evidence",
        phi,
        minBelief: threshold,
      },
    });
  }

  const deferredKindsByAtom = new Map<string, Set<string>>();
  for (const deferred of residual.deferred) {
    if (constraintIsEffectivelyMaterialized(deferred.constraint, residual, state)) continue;
    const constraint = deferred.constraint;
    const atoms =
      constraint.type === "Unresolved"
        ? [constraint.phi1, constraint.phi2]
        : "phi" in constraint
          ? [constraint.phi]
          : [];
    for (const atom of atoms) {
      if (!deps.includes(atom)) continue;
      const kinds = deferredKindsByAtom.get(atom) ?? new Set<string>();
      kinds.add(constraint.type);
      deferredKindsByAtom.set(atom, kinds);
    }
  }

  for (const atom of [...deferredKindsByAtom.keys()].sort()) {
    const delta: DeltaCandidate = {
      kind: "commit-deferred-dependency",
      phi: atom,
    };
    const after = applyDelta(delta, residual, state);
    certificates.push({
      blockerId: `deferred:${atom}`,
      blockerType: "epistemic_deferred",
      atoms: [atom],
      permanent: false,
      sufficient: !blocks(after.residual, after.state, action),
      ownership: blockerOwnership({
        blockerType: "epistemic_deferred",
        ownerRef: `approval:${atom}`,
      }),
      recommendations: {
        semantics: "advisory",
        moves: deferredRecommendations(atom, deferredKindsByAtom.get(atom) ?? new Set<string>()),
      },
      next: {
        kind: "satisfy_dependency",
        phi: atom,
      },
    });
  }

  return certificates.sort((left, right) => left.blockerId.localeCompare(right.blockerId));
}

export function filterBlocked(
  actionsCandidate: Action[],
  residualNew: Residual,
  stateNext: State
): { allowed: Action[]; blocked: Action[] } {
  const allowed: Action[] = [];
  const blocked: Action[] = [];
  for (const action of actionsCandidate) {
    if (blocks(residualNew, stateNext, action)) blocked.push(action);
    else allowed.push(action);
  }
  return { allowed, blocked };
}
