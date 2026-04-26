#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { compileRepairPlan } from "../runtime/repair";
import { blockerCertificates } from "../runtime/predicates";
import type {
  Action,
  AcquisitionMove,
  BlockerCertificate,
  EventContext,
  Input,
  Proposal,
  Residual,
  ResidualLimits,
  SessionArbitrationEvent,
  SessionConflictEvent,
  TensionTimeoutPolicy,
} from "../runtime/model";
import {
  SessionManager,
  type StepSessionRequest,
  type UpdateSessionRequest,
} from "./sessions";

type MappedTensionTimeoutPolicy = {
  maxSteps: number;
  wallClockMs?: number;
  defaultWinner?: "phi1" | "phi2";
  winnerByPair?: Record<string, string>;
};

const nonEmptyStringSchema = z.string().trim().min(1);

const constraintSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("Prop"),
      phi: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("RequireEvidence"),
      phi: nonEmptyStringSchema,
      threshold: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("Unresolved"),
      phi1: nonEmptyStringSchema,
      phi2: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("Prefer"),
      phi: nonEmptyStringSchema,
      weight: z.number().finite(),
    })
    .strict(),
  z
    .object({
      type: z.literal("Suspendable"),
      phi: nonEmptyStringSchema,
      condition: nonEmptyStringSchema,
    })
    .strict(),
]);

const proposalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("action"),
      type: nonEmptyStringSchema,
      dependsOn: z.array(nonEmptyStringSchema).optional(),
      revocable: z.boolean().optional(),
      readSet: z.array(nonEmptyStringSchema).optional(),
      writeSet: z.array(nonEmptyStringSchema).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("assumption"),
      phi: nonEmptyStringSchema,
      weight: z.number().finite(),
      decayPerStep: z.number().finite().optional(),
      createdAt: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("deferred"),
      constraint: constraintSchema,
      dependencies: z.array(nonEmptyStringSchema),
      stepsStuck: z.number().int().nonnegative().optional(),
      createdAt: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("tension"),
      phi1: nonEmptyStringSchema,
      phi2: nonEmptyStringSchema,
      stepsAlive: z.number().int().nonnegative().optional(),
      createdAt: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("evidence_gap"),
      phi: nonEmptyStringSchema,
      threshold: z.number().finite().nonnegative(),
      escalationSteps: z.number().int().positive().optional(),
      stepsWithoutEvidence: z.number().int().nonnegative().optional(),
      createdAt: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);

const actionSchema = z
  .object({
    kind: z.literal("action"),
    type: nonEmptyStringSchema,
    dependsOn: z.array(nonEmptyStringSchema).optional(),
    revocable: z.boolean().optional(),
    readSet: z.array(nonEmptyStringSchema).optional(),
    writeSet: z.array(nonEmptyStringSchema).optional(),
  })
  .strict();

const acquisitionMoveSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("observe"),
      target: nonEmptyStringSchema,
      reason: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("query"),
      target: nonEmptyStringSchema,
      reason: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("request_approval"),
      target: nonEmptyStringSchema,
      reason: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("run_check"),
      target: nonEmptyStringSchema,
      reason: nonEmptyStringSchema,
    })
    .strict(),
]);

const blockerDirectiveSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("replan_without_rejected_atom"),
      rejectedAtoms: z.array(nonEmptyStringSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("adjudicate_tension"),
      phi1: nonEmptyStringSchema,
      phi2: nonEmptyStringSchema,
      options: z
        .array(
          z
            .object({
              winner: nonEmptyStringSchema,
              sufficient: z.boolean(),
            })
            .strict()
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("provide_evidence"),
      phi: nonEmptyStringSchema,
      minBelief: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("satisfy_dependency"),
      phi: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("coordinate_session"),
      conflictType: z.enum(["write_write", "read_write"]),
      resource: nonEmptyStringSchema,
      otherSessionId: nonEmptyStringSchema,
      mode: z.enum(["serialize_first", "branch_split_required"]).optional(),
      outcome: z.enum(["serialize_wait", "branch_split_required"]).optional(),
      unblock: z
        .array(
          z
            .object({
              kind: nonEmptyStringSchema,
              detail: nonEmptyStringSchema,
            })
            .strict()
        )
        .min(1),
    })
    .strict(),
]);

const blockerCertificateSchema = z
  .object({
    blockerId: nonEmptyStringSchema,
    blockerType: z.enum([
      "epistemic_rejected",
      "epistemic_tension",
      "epistemic_evidence_gap",
      "epistemic_deferred",
      "session_coordination",
    ]),
    atoms: z.array(nonEmptyStringSchema),
    permanent: z.boolean(),
    sufficient: z.boolean(),
    recommendations: z
      .object({
        semantics: z.literal("advisory"),
        moves: z.array(acquisitionMoveSchema),
      })
      .strict(),
    next: blockerDirectiveSchema,
  })
  .strict();

const inputSchema = z
  .object({
    evidence: z.record(nonEmptyStringSchema, z.number().finite()).optional(),
    constraints: z.array(constraintSchema).optional(),
    adjudications: z
      .array(
        z
          .object({
            phi1: nonEmptyStringSchema,
            phi2: nonEmptyStringSchema,
            winner: nonEmptyStringSchema,
          })
          .strict()
      )
      .optional(),
    reopenSignals: z
      .array(
        z
          .object({
            phi1: nonEmptyStringSchema,
            phi2: nonEmptyStringSchema,
            source: nonEmptyStringSchema,
            reason: nonEmptyStringSchema,
          })
          .strict()
      )
      .optional(),
  })
  .strict();

const residualLimitsSchema = z
  .object({
  maxTensions: z.number().int().nonnegative().optional(),
  maxEvidenceGaps: z.number().int().nonnegative().optional(),
  maxDeferred: z.number().int().nonnegative().optional(),
  maxAssumptions: z.number().int().nonnegative().optional(),
  })
  .strict();

const mappedTimeoutPolicySchema = z
  .object({
    maxSteps: z.number().int().nonnegative(),
    wallClockMs: z.number().int().nonnegative().optional(),
    defaultWinner: z.enum(["phi1", "phi2"]).optional(),
    winnerByPair: z
      .record(nonEmptyStringSchema, nonEmptyStringSchema)
      .optional(),
  })
  .strict();

const eventContextSchema = z
  .object({
    branch: nonEmptyStringSchema.optional(),
    commitSha: nonEmptyStringSchema.optional(),
    worktreeId: nonEmptyStringSchema.optional(),
    actorId: nonEmptyStringSchema.optional(),
  })
  .strict();

const sessionMetadataInputSchema = z
  .object({
    objectiveType: nonEmptyStringSchema.optional(),
    objectiveRef: nonEmptyStringSchema.optional(),
    title: nonEmptyStringSchema.optional(),
    status: z.enum(["active", "closed"]).optional(),
    createdAt: z.number().int().nonnegative().optional(),
    closedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "active" && value.closedAt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closedAt"],
        message: "closedAt cannot be provided when status is active",
      });
    }

    if (
      value.closedAt !== undefined &&
      value.createdAt !== undefined &&
      value.closedAt < value.createdAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closedAt"],
        message: "closedAt cannot be earlier than createdAt",
      });
    }
  });

const arbitrationPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultMode: z
      .enum(["serialize_first", "branch_split_required"])
      .optional(),
    modeByConflictType: z
      .object({
        write_write: z
          .enum(["serialize_first", "branch_split_required"])
          .optional(),
        read_write: z
          .enum(["serialize_first", "branch_split_required"])
          .optional(),
      })
      .strict()
      .optional(),
    objectiveTypePriority: z
      .record(nonEmptyStringSchema, z.number().int())
      .optional(),
  })
  .strict();

const stepArgsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    proposals: z.array(proposalSchema).optional(),
    input: inputSchema.optional(),
    context: eventContextSchema.optional(),
    arbitrationPolicy: arbitrationPolicySchema.optional(),
    tensionTimeoutPolicy: mappedTimeoutPolicySchema.optional(),
    deadlockThreshold: z.number().int().positive().optional(),
    residualLimits: residualLimitsSchema.optional(),
    nowMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const getStateArgsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
  })
  .strict();

const stepOptionsSchema = z
  .object({
    arbitrationPolicy: arbitrationPolicySchema.optional(),
    tensionTimeoutPolicy: mappedTimeoutPolicySchema.optional(),
    deadlockThreshold: z.number().int().positive().optional(),
    residualLimits: residualLimitsSchema.optional(),
    nowMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const newSessionArgsSchema = z
  .object({
    sessionId: nonEmptyStringSchema.optional(),
    metadata: sessionMetadataInputSchema.optional(),
    seedProposals: z.array(proposalSchema).optional(),
    seedInput: inputSchema.optional(),
    stepOptions: stepOptionsSchema.optional(),
  })
  .strict();

const sessionMetadataPatchSchema = z
  .object({
    objectiveType: nonEmptyStringSchema.optional(),
    objectiveRef: nonEmptyStringSchema.optional(),
    title: nonEmptyStringSchema.optional(),
    status: z.enum(["active", "closed"]).optional(),
    closedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "active" && value.closedAt !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closedAt"],
        message: "closedAt cannot be provided when status is active",
      });
    }
  });

const updateSessionArgsSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    metadata: sessionMetadataPatchSchema.optional(),
    releaseResourceClaims: z.boolean().optional(),
  })
  .strict();

const suggestRepairsArgsSchema = z
  .object({
    blocked: z
      .object({
        action: actionSchema,
        certificates: z.array(blockerCertificateSchema).min(1),
      })
      .strict(),
  })
  .strict();

type StepArgs = z.infer<typeof stepArgsSchema>;
type NewSessionArgs = z.infer<typeof newSessionArgsSchema>;
type UpdateSessionArgs = z.infer<typeof updateSessionArgsSchema>;
type SuggestRepairsArgs = z.infer<typeof suggestRepairsArgsSchema>;

function toToolResponse(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function mapTimeoutPolicy(policy?: MappedTensionTimeoutPolicy): TensionTimeoutPolicy | undefined {
  if (!policy) return undefined;

  const winnerByPair = policy.winnerByPair ?? {};

  return {
    maxSteps: policy.maxSteps,
    wallClockMs: policy.wallClockMs,
    resolve: (phi1: string, phi2: string): string => {
      const direct = winnerByPair[`${phi1}::${phi2}`];
      if (direct !== undefined) return direct;

      const reverse = winnerByPair[`${phi2}::${phi1}`];
      if (reverse !== undefined) return reverse;

      return policy.defaultWinner === "phi2" ? phi2 : phi1;
    },
  };
}

function mapStepRequest(args: {
  proposals?: Proposal[];
  input?: Input;
  context?: EventContext;
  arbitrationPolicy?: StepSessionRequest["arbitrationPolicy"];
  tensionTimeoutPolicy?: MappedTensionTimeoutPolicy;
  deadlockThreshold?: number;
  residualLimits?: ResidualLimits;
  nowMs?: number;
}): StepSessionRequest {
  return {
    proposals: args.proposals ?? [],
    input: args.input ?? {},
    context: args.context,
    arbitrationPolicy: args.arbitrationPolicy,
    tensionTimeoutPolicy: mapTimeoutPolicy(args.tensionTimeoutPolicy),
    deadlockThreshold: args.deadlockThreshold,
    residualLimits: args.residualLimits,
    nowMs: args.nowMs,
  };
}

function summarizeResidualCounts(residual: Residual) {
  const counts = {
    assumptions: residual.assumptions.length,
    deferred: residual.deferred.length,
    tensions: residual.tensions.length,
    evidenceGaps: residual.evidenceGaps.length,
  };

  return {
    counts,
    hasOpenBlockers: counts.deferred + counts.tensions + counts.evidenceGaps > 0,
  };
}

function summarizeResidualVerbose(residual: Residual) {
  return {
    ...summarizeResidualCounts(residual),
    assumptions: residual.assumptions,
    deferred: residual.deferred,
    tensions: residual.tensions,
    evidenceGaps: residual.evidenceGaps,
  };
}

function actionKey(action: Action): string {
  return JSON.stringify({
    type: action.type,
    dependsOn: (action.dependsOn ?? []).slice().sort(),
    readSet: (action.readSet ?? []).slice().sort(),
    writeSet: (action.writeSet ?? []).slice().sort(),
    revocable: action.revocable === true,
  });
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

function sessionCoordinationRecommendations(args: {
  conflict: SessionConflictEvent;
  arbitration?: SessionArbitrationEvent;
}): AcquisitionMove[] {
  const { conflict, arbitration } = args;
  const base: AcquisitionMove[] = [
    {
      kind: "query",
      target: `session:${conflict.otherSessionId}/resource:${conflict.resource}`,
      reason: "Query ownership and expected release/merge timing for the conflicting resource.",
    },
  ];

  const mode = arbitration?.mode;
  const outcome = arbitration?.outcome;

  if (mode === "branch_split_required" || outcome === "branch_split_required") {
    base.push({
      kind: "request_approval",
      target: `coordination:${conflict.resource}`,
      reason: "Request a branch-split or merge-plan decision to resolve the coordination conflict.",
    });
  } else {
    base.push({
      kind: "observe",
      target: `resource:${conflict.resource}`,
      reason: "Observe until the conflicting claim is released, then retry the blocked action.",
    });
  }

  return dedupeMoves(base);
}

function buildSessionCertificates(
  action: Action,
  sessionConflicts: SessionConflictEvent[],
  sessionArbitrations: SessionArbitrationEvent[]
): BlockerCertificate[] {
  const actionScopedConflicts = sessionConflicts.filter(
    (conflict) => actionKey(conflict.action) === actionKey(action)
  );
  const arbitrationByConflictKey = new Map(
    sessionArbitrations
      .filter((arbitration) => actionKey(arbitration.action) === actionKey(action))
      .map((arbitration) => [
        `${arbitration.conflictType}|${arbitration.resource}|${arbitration.otherSessionId}`,
        arbitration,
      ])
  );

  const certificates: BlockerCertificate[] = [];
  for (const conflict of actionScopedConflicts) {
    const certificateKey = `${conflict.conflictType}|${conflict.resource}|${conflict.otherSessionId}`;
    const arbitration = arbitrationByConflictKey.get(certificateKey);
    certificates.push({
      blockerId: `session:${certificateKey}`,
      blockerType: "session_coordination",
      atoms: [conflict.resource],
      permanent: false,
      sufficient: false,
      recommendations: {
        semantics: "advisory",
        moves: sessionCoordinationRecommendations({ conflict, arbitration }),
      },
      next: {
        kind: "coordinate_session",
        conflictType: conflict.conflictType,
        resource: conflict.resource,
        otherSessionId: conflict.otherSessionId,
        mode: arbitration?.mode,
        outcome: arbitration?.outcome,
        unblock: (arbitration?.unblock ?? conflict.unblock).map((item) => ({
          kind: item.kind,
          detail: item.detail,
        })),
      },
    });
  }

  return certificates;
}

function summarizeBlockedActions(args: {
  actionsBlocked: Action[];
  residual: Residual;
  state: ReturnType<SessionManager["getState"]>["state"];
  sessionConflicts: SessionConflictEvent[];
  sessionArbitrations: SessionArbitrationEvent[];
}) {
  return {
    blocked: args.actionsBlocked.map((action) => ({
      action,
      certificates: [
        ...blockerCertificates(action, args.residual, args.state),
        ...buildSessionCertificates(
          action,
          args.sessionConflicts,
          args.sessionArbitrations
        ),
      ],
    })),
  };
}

export function createResidualMcpServer(options?: { sessionRootDir?: string }) {
  const sessionManager = new SessionManager(options?.sessionRootDir);

  const server = new McpServer(
    {
      name: "residual-runtime",
      version: "0.1.0",
    },
    {
      instructions:
        "Use step() as the coordination gate for shared epistemic state. Create or pick a session ID first, then keep using that same session ID across collaborating agents.",
    }
  );

  server.registerTool(
    "step",
    {
      description:
        "Advance one shared session step with optional proposals and input, then return approved actions, blocker certificates (strict unblock semantics plus advisory acquisition moves), residual counts, and events.",
      inputSchema: stepArgsSchema,
    },
    async (args: StepArgs) => {
      const request = mapStepRequest(args);
      const result = sessionManager.stepSession(args.sessionId, request);
      const snapshot = sessionManager.getState(args.sessionId);
      const blockedSummary = summarizeBlockedActions({
        actionsBlocked: result.actionsBlocked,
        residual: result.residualNext,
        state: result.stateNext,
        sessionConflicts: result.sessionConflicts,
        sessionArbitrations: result.sessionArbitrations,
      });

      return toToolResponse({
        sessionId: args.sessionId,
        stepCount: snapshot.stepCount,
        metadata: snapshot.metadata,
        heldResourceClaims: snapshot.heldResourceClaims,
        lastEventContext: snapshot.lastEventContext,
        actionsApproved: result.actionsApproved,
        ...blockedSummary,
        residualSummary: summarizeResidualCounts(result.residualNext),
        events: {
          escalations: result.escalations,
          deadlocks: result.deadlocks,
          overflows: result.overflows,
          oscillations: result.oscillations,
          invalidAdjudications: result.invalidAdjudications,
          autoAdjudications: result.autoAdjudications,
          revokedActions: result.revokedActions,
          reopenApplied: result.reopenApplied,
          reopenBlocked: result.reopenBlocked,
          sessionArbitrationPolicy: result.sessionArbitrationPolicy,
          sessionConflicts: result.sessionConflicts,
          sessionArbitrations: result.sessionArbitrations,
        },
        softBlocked: result.softBlocked,
      });
    }
  );

  server.registerTool(
    "suggest_repairs",
    {
      description:
        "Compile blocked-action certificates into a deterministic repair plan without mutating session state.",
      inputSchema: suggestRepairsArgsSchema,
    },
    async (args: SuggestRepairsArgs) => {
      const repairPlan = compileRepairPlan(
        args.blocked.certificates as BlockerCertificate[]
      );
      return toToolResponse({
        action: args.blocked.action,
        repairPlan,
        surface: "suggest_repairs",
        rationale:
          "Planning-only MCP surface: strict blocker semantics are compiled into a stable repair agenda with no side effects.",
      });
    }
  );

  server.registerTool(
    "get_state",
    {
      description: "Return current state and residual for a session.",
      inputSchema: getStateArgsSchema,
    },
    async (args: z.infer<typeof getStateArgsSchema>) => {
      const snapshot = sessionManager.getState(args.sessionId);
      return toToolResponse({
        sessionId: args.sessionId,
        stepCount: snapshot.stepCount,
        metadata: snapshot.metadata,
        heldResourceClaims: snapshot.heldResourceClaims,
        lastEventContext: snapshot.lastEventContext,
        state: snapshot.state,
        residual: snapshot.residual,
        residualSummary: summarizeResidualVerbose(snapshot.residual),
      });
    }
  );

  server.registerTool(
    "new_session",
    {
      description: "Create a new session, optionally with seed proposals/input.",
      inputSchema: newSessionArgsSchema.optional(),
    },
    async (args) => {
      const request: NewSessionArgs = args ?? {};
      const snapshot = sessionManager.newSession({
        sessionId: request.sessionId,
        metadata: request.metadata,
        seedInput: request.seedInput,
        seedProposals: request.seedProposals,
        stepOptions: request.stepOptions
          ? {
              arbitrationPolicy: request.stepOptions.arbitrationPolicy,
              tensionTimeoutPolicy: mapTimeoutPolicy(request.stepOptions.tensionTimeoutPolicy),
              deadlockThreshold: request.stepOptions.deadlockThreshold,
              residualLimits: request.stepOptions.residualLimits,
              nowMs: request.stepOptions.nowMs,
            }
          : undefined,
      });

      return toToolResponse({
        sessionId: snapshot.sessionId,
        stepCount: snapshot.stepCount,
        metadata: snapshot.metadata,
        heldResourceClaims: snapshot.heldResourceClaims,
        lastEventContext: snapshot.lastEventContext,
        sessionPath: sessionManager.getLogPath(snapshot.sessionId),
        state: snapshot.state,
        residual: snapshot.residual,
      });
    }
  );

  server.registerTool(
    "update_session",
    {
      description:
        "Update session lifecycle metadata and explicitly release held resource claims.",
      inputSchema: updateSessionArgsSchema,
    },
    async (args: UpdateSessionArgs) => {
      const request: UpdateSessionRequest = {
        metadata: args.metadata,
        releaseResourceClaims: args.releaseResourceClaims,
      };
      const snapshot = sessionManager.updateSession(args.sessionId, request);

      return toToolResponse({
        sessionId: snapshot.sessionId,
        stepCount: snapshot.stepCount,
        metadata: snapshot.metadata,
        heldResourceClaims: snapshot.heldResourceClaims,
        lastEventContext: snapshot.lastEventContext,
        state: snapshot.state,
        residual: snapshot.residual,
      });
    }
  );

  server.registerTool(
    "list_sessions",
    {
      description: "List all known sessions and their step counts.",
    },
    async () => {
      return toToolResponse({
        sessionRootDir: sessionManager.rootPath,
        sessions: sessionManager.listSessions(),
      });
    }
  );

  return { server, sessionManager };
}

export async function runStdioServer(options?: { sessionRootDir?: string }): Promise<void> {
  const { server } = createResidualMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  runStdioServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`Failed to start MCP server: ${message}\n`);
    process.exit(1);
  });
}
