import { step } from "./engine";
import { blockerCertificates } from "./predicates";
import type {
  Action,
  AcquisitionMove,
  BlockerCertificate,
  EventContext,
  Input,
  Proposal,
  Residual,
  State,
} from "./types/domain";
import type {
  RepairAdapter,
  RepairAdvice,
  RepairAdapterRequest,
  RepairCycleTrace,
  RepairDirective,
  RepairIntent,
  RepairPlan,
  RepairObservation,
  RunRepairCycleFailureCode,
  RunRepairCycleParams,
  RunRepairCycleResult,
  SeededFakeAdapterOptions,
  SeededFakeObservation,
  RepairTraceEntry,
} from "./types/repair";

function cloneMoves(moves: AcquisitionMove[]): AcquisitionMove[] {
  return moves.map((move) => ({ ...move }));
}

function cloneAdvice(advice: RepairAdvice): RepairAdvice {
  return {
    semantics: advice.semantics,
    moves: cloneMoves(advice.moves),
  };
}

function cloneDirective(next: RepairDirective): RepairDirective {
  switch (next.kind) {
    case "replan_without_rejected_atom":
      return {
        kind: next.kind,
        rejectedAtoms: [...next.rejectedAtoms],
      };
    case "adjudicate_tension":
      return {
        kind: next.kind,
        phi1: next.phi1,
        phi2: next.phi2,
        options: next.options.map((option) => ({ ...option })),
      };
    case "provide_evidence":
      return {
        kind: next.kind,
        phi: next.phi,
        minBelief: next.minBelief,
      };
    case "satisfy_dependency":
      return {
        kind: next.kind,
        phi: next.phi,
      };
    case "coordinate_session":
      return {
        kind: next.kind,
        conflictType: next.conflictType,
        resource: next.resource,
        otherSessionId: next.otherSessionId,
        mode: next.mode,
        outcome: next.outcome,
        unblock: next.unblock.map((item) => ({ ...item })),
      };
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function actionKey(action: Action): string {
  return JSON.stringify({
    kind: action.kind,
    type: action.type,
    dependsOn: (action.dependsOn ?? []).slice().sort(),
    revocable: action.revocable === true,
    readSet: (action.readSet ?? []).slice().sort(),
    writeSet: (action.writeSet ?? []).slice().sort(),
  });
}

function compareCertificates(
  left: { certificate: BlockerCertificate; sourceIndex: number },
  right: { certificate: BlockerCertificate; sourceIndex: number }
): number {
  const byId = left.certificate.blockerId.localeCompare(right.certificate.blockerId);
  if (byId !== 0) return byId;
  return left.sourceIndex - right.sourceIndex;
}

function toRepairIntent(
  certificate: BlockerCertificate,
  sourceIndex: number,
  stableOrder: number
): RepairIntent {
  const trace: RepairTraceEntry = {
    blockerId: certificate.blockerId,
    blockerType: certificate.blockerType,
    sourceIndex,
    stableOrder,
  };
  const base = {
    intentId: `repair:${certificate.blockerId}`,
    blockerId: certificate.blockerId,
    blockerType: certificate.blockerType,
    atoms: [...certificate.atoms],
    permanent: certificate.permanent,
    sufficient: certificate.sufficient,
    advisory: cloneAdvice(certificate.recommendations),
    trace,
  };
  const strict = cloneDirective(certificate.next);

  if (strict.kind === "replan_without_rejected_atom") {
    return {
      ...base,
      kind: "replan",
      resolution: "replan_required",
      strict,
    };
  }

  return {
    ...base,
    kind: "repair",
    resolution: certificate.sufficient ? "single_step" : "multi_step",
    strict,
  };
}

export function compileRepairPlan(certificates: BlockerCertificate[]): RepairPlan {
  const ordered = certificates
    .map((certificate, sourceIndex) => ({ certificate, sourceIndex }))
    .sort(compareCertificates);
  const intents = ordered.map(({ certificate, sourceIndex }, stableOrder) =>
    toRepairIntent(certificate, sourceIndex, stableOrder)
  );
  const permanentBlockerIds = intents
    .filter((intent) => intent.permanent)
    .map((intent) => intent.blockerId);
  const summary = {
    permanentBlockers: permanentBlockerIds.length,
    actionableIntents: intents.filter((intent) => intent.kind === "repair").length,
    requiresReplan: permanentBlockerIds.length > 0,
    singleStepIntents: intents.filter((intent) => intent.kind === "repair" && intent.resolution === "single_step").length,
    multiStepIntents: intents.filter((intent) => intent.kind === "repair" && intent.resolution === "multi_step").length,
  };

  return {
    intents,
    trace: {
      compiler: "compileRepairPlan",
      source: "blocker_certificates",
      ordering: "blockerId:asc",
      inputCount: certificates.length,
      intentCount: intents.length,
      blockerIds: intents.map((intent) => intent.blockerId),
      permanentBlockerIds,
      advisoryMoveCount: intents.reduce((total, intent) => total + intent.advisory.moves.length, 0),
      entries: intents.map((intent) => ({ ...intent.trace })),
    },
    summary,
  };
}

function mergeContext(
  base: EventContext | undefined,
  patch: EventContext | undefined
): EventContext | undefined {
  if (!base && !patch) return undefined;
  return {
    ...(base ?? {}),
    ...(patch ?? {}),
  };
}

function compactInput(parts: {
  evidence: Record<string, number>;
  constraints: NonNullable<Input["constraints"]>;
  adjudications: NonNullable<Input["adjudications"]>;
  reopenSignals: NonNullable<Input["reopenSignals"]>;
}): Input {
  const input: Input = {};
  if (Object.keys(parts.evidence).length > 0) input.evidence = parts.evidence;
  if (parts.constraints.length > 0) input.constraints = parts.constraints;
  if (parts.adjudications.length > 0) input.adjudications = parts.adjudications;
  if (parts.reopenSignals.length > 0) input.reopenSignals = parts.reopenSignals;
  return input;
}

function applyObservationPatches(observations: RepairObservation[]): {
  input: Input;
  proposals: Proposal[];
  context?: EventContext;
} {
  const evidence: Record<string, number> = {};
  const constraints: NonNullable<Input["constraints"]> = [];
  const adjudications: NonNullable<Input["adjudications"]> = [];
  const reopenSignals: NonNullable<Input["reopenSignals"]> = [];
  const proposals: Proposal[] = [];
  let context: EventContext | undefined = undefined;

  for (const observation of observations) {
    if (observation.inputPatch?.evidence) {
      for (const [phi, value] of Object.entries(observation.inputPatch.evidence)) {
        evidence[phi] = value;
      }
    }
    if (observation.inputPatch?.constraints) {
      constraints.push(...deepClone(observation.inputPatch.constraints));
    }
    if (observation.inputPatch?.adjudications) {
      adjudications.push(...deepClone(observation.inputPatch.adjudications));
    }
    if (observation.inputPatch?.reopenSignals) {
      reopenSignals.push(...deepClone(observation.inputPatch.reopenSignals));
    }
    if (observation.proposalPatch) {
      proposals.push(...deepClone(observation.proposalPatch));
    }
    context = mergeContext(context, observation.contextPatch ? deepClone(observation.contextPatch) : undefined);
  }

  return {
    input: compactInput({ evidence, constraints, adjudications, reopenSignals }),
    proposals,
    context,
  };
}

function updateActiveRevocable(
  current: Action[],
  emittedRevocable: Action[],
  revokedActions: Action[]
): Action[] {
  const revoked = new Set(revokedActions.map(actionKey));
  const next = current
    .filter((action) => !revoked.has(actionKey(action)))
    .map((action) => deepClone(action));
  const seen = new Set(next.map(actionKey));

  for (const action of emittedRevocable) {
    const key = actionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(deepClone(action));
  }

  return next;
}

function strictRequestForIntent(args: {
  cycle: number;
  intent: RepairIntent;
  targetAction: Action;
  state: State;
  residual: Residual;
  context?: EventContext;
}): RepairAdapterRequest | undefined {
  const { intent } = args;
  if (intent.kind !== "repair") return undefined;
  const base = {
    cycle: args.cycle,
    intent,
    targetAction: args.targetAction,
    state: args.state,
    residual: args.residual,
    context: args.context,
  };

  switch (intent.strict.kind) {
    case "adjudicate_tension":
      return {
        ...base,
        capability: "adjudicate",
        source: "strict",
        directive: intent.strict,
        target: `${intent.strict.phi1}|${intent.strict.phi2}`,
      };
    case "provide_evidence":
      return {
        ...base,
        capability: "run_check",
        source: "strict",
        directive: intent.strict,
        target: intent.strict.phi,
      };
    case "satisfy_dependency":
      return {
        ...base,
        capability: "request_approval",
        source: "strict",
        directive: intent.strict,
        target: intent.strict.phi,
      };
    case "coordinate_session":
      return {
        ...base,
        capability: "coordinate",
        source: "strict",
        directive: intent.strict,
        target: intent.strict.resource,
      };
  }
}

function advisoryRequestForMove(args: {
  cycle: number;
  intent: RepairIntent;
  move: AcquisitionMove;
  targetAction: Action;
  state: State;
  residual: Residual;
  context?: EventContext;
}): RepairAdapterRequest | undefined {
  const base = {
    cycle: args.cycle,
    intent: args.intent,
    targetAction: args.targetAction,
    state: args.state,
    residual: args.residual,
    context: args.context,
    source: "advisory" as const,
    target: args.move.target,
  };

  switch (args.move.kind) {
    case "query":
      return {
        ...base,
        capability: "query",
        move: args.move,
      };
    case "run_check":
      return {
        ...base,
        capability: "run_check",
        move: args.move,
      };
    case "request_approval":
      return {
        ...base,
        capability: "request_approval",
        move: args.move,
      };
    case "observe":
      return {
        ...base,
        capability: "observe",
        move: args.move,
      };
  }
}

function invokeAdapterCapability(args: {
  adapter: RepairAdapter;
  request: RepairAdapterRequest;
}):
  | { ok: true; observations: RepairObservation[] }
  | { ok: false; code: RunRepairCycleFailureCode; message: string } {
  const { adapter, request } = args;
  const capabilities = adapter.capabilities;

  switch (request.capability) {
    case "query": {
      if (!capabilities.query) {
        return {
          ok: false,
          code: "missing_capability",
          message: `Missing adapter capability "query" for blocker "${request.intent.blockerId}".`,
        };
      }
      const raw = capabilities.query(request);
      const observations = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      return { ok: true, observations: observations.map((item) => deepClone(item)) };
    }
    case "run_check": {
      if (!capabilities.run_check) {
        return {
          ok: false,
          code: "missing_capability",
          message: `Missing adapter capability "run_check" for blocker "${request.intent.blockerId}".`,
        };
      }
      const raw = capabilities.run_check(request);
      const observations = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      return { ok: true, observations: observations.map((item) => deepClone(item)) };
    }
    case "request_approval": {
      if (!capabilities.request_approval) {
        return {
          ok: false,
          code: "missing_capability",
          message: `Missing adapter capability "request_approval" for blocker "${request.intent.blockerId}".`,
        };
      }
      const raw = capabilities.request_approval(request);
      const observations = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      return { ok: true, observations: observations.map((item) => deepClone(item)) };
    }
    case "observe": {
      if (!capabilities.observe) {
        return {
          ok: false,
          code: "missing_capability",
          message: `Missing adapter capability "observe" for blocker "${request.intent.blockerId}".`,
        };
      }
      const raw = capabilities.observe(request);
      const observations = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      return { ok: true, observations: observations.map((item) => deepClone(item)) };
    }
    case "adjudicate": {
      if (!capabilities.adjudicate) {
        return {
          ok: false,
          code: "missing_capability",
          message: `Missing adapter capability "adjudicate" for blocker "${request.intent.blockerId}".`,
        };
      }
      const raw = capabilities.adjudicate(request);
      const observations = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      return { ok: true, observations: observations.map((item) => deepClone(item)) };
    }
    case "coordinate": {
      if (!capabilities.coordinate) {
        return {
          ok: false,
          code: "missing_capability",
          message: `Missing adapter capability "coordinate" for blocker "${request.intent.blockerId}".`,
        };
      }
      const raw = capabilities.coordinate(request);
      const observations = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      return { ok: true, observations: observations.map((item) => deepClone(item)) };
    }
  }
}

function buildFailureResult(args: {
  code: RunRepairCycleFailureCode;
  message: string;
  cycles: RepairCycleTrace[];
  state: State;
  residual: Residual;
  context?: EventContext;
  fingerprintHistory: string[];
  activeRevocable: Action[];
  lastReplay?: RunRepairCycleResult["lastReplay"];
}): RunRepairCycleResult {
  return {
    status: "failed",
    failureCode: args.code,
    failureMessage: args.message,
    targetActionApproved: false,
    cycles: args.cycles,
    state: args.state,
    residual: args.residual,
    context: args.context,
    fingerprintHistory: args.fingerprintHistory,
    activeRevocable: args.activeRevocable,
    ...(args.lastReplay ? { lastReplay: args.lastReplay } : {}),
  };
}

export function runRepairCycle(params: RunRepairCycleParams): RunRepairCycleResult {
  const maxCycles = params.maxCycles ?? 3;
  let state = deepClone(params.state);
  let residual = deepClone(params.residual);
  let context = params.initialContext ? deepClone(params.initialContext) : undefined;
  let fingerprintHistory = [...(params.fingerprintHistory ?? [])];
  let activeRevocable = [...(params.priorRevocable ?? [])].map((action) => deepClone(action));
  let lastReplay: RunRepairCycleResult["lastReplay"] = undefined;
  const cycles: RepairCycleTrace[] = [];
  const targetKey = actionKey(params.targetAction);

  if (maxCycles <= 0) {
    return buildFailureResult({
      code: "max_cycles_exceeded",
      message: `maxCycles must be greater than zero. Received ${maxCycles}.`,
      cycles,
      state,
      residual,
      context,
      fingerprintHistory,
      activeRevocable,
    });
  }

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const certificates = blockerCertificates(params.targetAction, residual, state);
    const plan = compileRepairPlan(certificates);

    if (plan.summary.requiresReplan) {
      cycles.push({
        cycle,
        certificates: deepClone(certificates),
        plan: deepClone(plan),
        observations: [],
        generatedInput: {},
        generatedProposals: [],
        generatedContext: context ? deepClone(context) : undefined,
      });
      return buildFailureResult({
        code: "permanent_blocker",
        message: `Permanent blocker detected. Replan is required before "${params.targetAction.type}" can continue.`,
        cycles,
        state,
        residual,
        context,
        fingerprintHistory,
        activeRevocable,
        lastReplay,
      });
    }

    const observations: RepairObservation[] = [];

    for (const intent of plan.intents) {
      if (intent.kind !== "repair") continue;

      const strictRequest = strictRequestForIntent({
        cycle,
        intent,
        targetAction: params.targetAction,
        state,
        residual,
        context,
      });
      if (strictRequest) {
        const strictResult = invokeAdapterCapability({
          adapter: params.adapter,
          request: strictRequest,
        });
        if (!strictResult.ok) {
          cycles.push({
            cycle,
            certificates: deepClone(certificates),
            plan: deepClone(plan),
            observations: deepClone(observations),
            generatedInput: {},
            generatedProposals: [],
            generatedContext: context ? deepClone(context) : undefined,
          });
          return buildFailureResult({
            code: strictResult.code,
            message: strictResult.message,
            cycles,
            state,
            residual,
            context,
            fingerprintHistory,
            activeRevocable,
            lastReplay,
          });
        }
        observations.push(...strictResult.observations);
      }

      for (const move of intent.advisory.moves) {
        const advisoryRequest = advisoryRequestForMove({
          cycle,
          intent,
          move,
          targetAction: params.targetAction,
          state,
          residual,
          context,
        });
        if (!advisoryRequest) continue;

        const advisoryResult = invokeAdapterCapability({
          adapter: params.adapter,
          request: advisoryRequest,
        });
        if (!advisoryResult.ok) {
          cycles.push({
            cycle,
            certificates: deepClone(certificates),
            plan: deepClone(plan),
            observations: deepClone(observations),
            generatedInput: {},
            generatedProposals: [],
            generatedContext: context ? deepClone(context) : undefined,
          });
          return buildFailureResult({
            code: advisoryResult.code,
            message: advisoryResult.message,
            cycles,
            state,
            residual,
            context,
            fingerprintHistory,
            activeRevocable,
            lastReplay,
          });
        }
        observations.push(...advisoryResult.observations);
      }
    }

    const generated = applyObservationPatches(observations);
    context = mergeContext(context, generated.context);

    const stepResult = step({
      state,
      residual,
      input: generated.input,
      proposals: [deepClone(params.targetAction), ...deepClone(generated.proposals)],
      transitionEngine: params.transitionEngine,
      tensionTimeoutPolicy: params.tensionTimeoutPolicy,
      deadlockThreshold: params.deadlockThreshold,
      residualLimits: params.residualLimits,
      fingerprintHistory,
      priorRevocable: activeRevocable,
      nowMs: params.nowMs,
    });

    state = deepClone(stepResult.stateNext);
    residual = deepClone(stepResult.residualNext);
    fingerprintHistory = [...stepResult.fingerprintHistory];
    activeRevocable = updateActiveRevocable(
      activeRevocable,
      stepResult.emittedRevocable,
      stepResult.revokedActions
    );
    lastReplay = deepClone(stepResult.replay);

    cycles.push({
      cycle,
      certificates: deepClone(certificates),
      plan: deepClone(plan),
      observations: deepClone(observations),
      generatedInput: deepClone(generated.input),
      generatedProposals: deepClone(generated.proposals),
      generatedContext: context ? deepClone(context) : undefined,
      stepResult: {
        actionsApproved: deepClone(stepResult.actionsApproved),
        actionsBlocked: deepClone(stepResult.actionsBlocked),
        replay: deepClone(stepResult.replay),
      },
    });

    const targetActionApproved = stepResult.actionsApproved.some(
      (action) => actionKey(action) === targetKey
    );
    if (targetActionApproved) {
      return {
        status: "resolved",
        targetActionApproved: true,
        cycles,
        state,
        residual,
        context,
        fingerprintHistory,
        activeRevocable,
        ...(lastReplay ? { lastReplay } : {}),
      };
    }
  }

  return buildFailureResult({
    code: "max_cycles_exceeded",
    message: `Repair cycle exceeded maxCycles (${maxCycles}) without approving "${params.targetAction.type}".`,
    cycles,
    state,
    residual,
    context,
    fingerprintHistory,
    activeRevocable,
    lastReplay,
  });
}

function createSeededObservation(args: {
  adapterId: string;
  capability: "query" | "run_check" | "request_approval" | "observe" | "adjudicate" | "coordinate";
  scripted?: SeededFakeObservation;
  request: RepairAdapterRequest;
  observedAt: number;
}): RepairObservation {
  return {
    provenance: {
      adapterId: args.adapterId,
      capability: args.capability,
      source: args.request.source,
      blockerId: args.request.intent.blockerId,
      intentId: args.request.intent.intentId,
      target: args.request.target,
      observedAt: args.observedAt,
      ...(args.scripted?.note ? { note: args.scripted.note } : {}),
    },
    ...(args.scripted?.inputPatch ? { inputPatch: deepClone(args.scripted.inputPatch) } : {}),
    ...(args.scripted?.proposalPatch ? { proposalPatch: deepClone(args.scripted.proposalPatch) } : {}),
    ...(args.scripted?.contextPatch ? { contextPatch: deepClone(args.scripted.contextPatch) } : {}),
  };
}

export function createSeededFakeRepairAdapter(
  options?: SeededFakeAdapterOptions
): RepairAdapter {
  const adapterId = options?.adapterId ?? "seeded-fake-adapter";
  const script = options?.script ?? {};
  const cursors: Record<
    "query" | "run_check" | "request_approval" | "observe" | "adjudicate" | "coordinate",
    number
  > = {
    query: 0,
    run_check: 0,
    request_approval: 0,
    observe: 0,
    adjudicate: 0,
    coordinate: 0,
  };
  let tick = options?.seed ?? 0;

  const nextScripted = (
    capability: keyof typeof cursors
  ): SeededFakeObservation | undefined => {
    const index = cursors[capability];
    cursors[capability] += 1;
    return script[capability]?.[index];
  };

  const nextObservedAt = (): number => {
    const value = tick;
    tick += 1;
    return value;
  };

  return {
    adapterId,
    capabilities: {
      query: (request) =>
        createSeededObservation({
          adapterId,
          capability: "query",
          scripted: nextScripted("query"),
          request,
          observedAt: nextObservedAt(),
        }),
      run_check: (request) =>
        createSeededObservation({
          adapterId,
          capability: "run_check",
          scripted: nextScripted("run_check"),
          request,
          observedAt: nextObservedAt(),
        }),
      request_approval: (request) =>
        createSeededObservation({
          adapterId,
          capability: "request_approval",
          scripted: nextScripted("request_approval"),
          request,
          observedAt: nextObservedAt(),
        }),
      observe: (request) =>
        createSeededObservation({
          adapterId,
          capability: "observe",
          scripted: nextScripted("observe"),
          request,
          observedAt: nextObservedAt(),
        }),
      adjudicate: (request) =>
        createSeededObservation({
          adapterId,
          capability: "adjudicate",
          scripted: nextScripted("adjudicate"),
          request,
          observedAt: nextObservedAt(),
        }),
      coordinate: (request) =>
        createSeededObservation({
          adapterId,
          capability: "coordinate",
          scripted: nextScripted("coordinate"),
          request,
          observedAt: nextObservedAt(),
        }),
    },
  };
}
