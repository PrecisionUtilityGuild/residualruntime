import type {
  SessionArbitrationEvent,
  SessionArbitrationMode,
  SessionArbitrationPolicy,
  SessionConflictEvent,
  SessionConflictType,
  SessionMetadata,
} from "../runtime/model";

export type SessionArbitrationPolicyInput = {
  enabled?: boolean;
  defaultMode?: SessionArbitrationMode;
  modeByConflictType?: Partial<Record<SessionConflictType, SessionArbitrationMode>>;
  objectiveTypePriority?: Record<string, number>;
};

type ArbitrationParams = {
  sessionId: string;
  sessionMetadata: SessionMetadata;
  conflicts: SessionConflictEvent[];
  peerMetadataBySessionId: Record<string, SessionMetadata>;
  policy: SessionArbitrationPolicy;
  conflictFreshnessMsByKey?: Record<string, number>;
};

const DEFAULT_OBJECTIVE_TYPE_PRIORITY: Record<string, number> = {
  incident: 400,
  hotfix: 300,
  release: 250,
  migration: 200,
  pr: 150,
  ticket: 100,
  default: 50,
};

const CONFLICT_RANK: Record<SessionConflictType, number> = {
  write_write: 2,
  read_write: 1,
};

function normalizeMode(
  value: string | undefined,
  fallback: SessionArbitrationMode
): SessionArbitrationMode {
  if (!value) return fallback;
  if (value === "serialize_first" || value === "branch_split_required") {
    return value;
  }
  return fallback;
}

function parseBooleanEnv(
  value: string | undefined,
  fallback: boolean
): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return fallback;
}

function normalizeObjectiveType(
  objectiveType: string | undefined
): string {
  return (objectiveType ?? "").trim().toLowerCase();
}

function objectivePriority(
  metadata: SessionMetadata | undefined,
  policy: SessionArbitrationPolicy
): number {
  const objectiveType = normalizeObjectiveType(metadata?.objectiveType);
  if (objectiveType.length > 0) {
    const explicit = policy.objectiveTypePriority[objectiveType];
    if (explicit !== undefined) return explicit;
  }
  return policy.objectiveTypePriority.default ?? 0;
}

function normalizeObjectiveTypePriority(
  source: Record<string, number>
): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = normalizeObjectiveType(key);
    if (normalizedKey.length === 0) continue;
    normalized[normalizedKey] = value;
  }
  return normalized;
}

function actionKey(action: {
  type: string;
  dependsOn?: string[];
  readSet?: string[];
  writeSet?: string[];
}): string {
  return JSON.stringify({
    type: action.type,
    dependsOn: (action.dependsOn ?? []).slice().sort(),
    readSet: (action.readSet ?? []).slice().sort(),
    writeSet: (action.writeSet ?? []).slice().sort(),
  });
}

function selectPreferredSession(
  sessionId: string,
  sessionMetadata: SessionMetadata,
  otherSessionId: string,
  otherSessionMetadata: SessionMetadata | undefined,
  policy: SessionArbitrationPolicy
): {
  preferredSessionId: string;
  sessionPriority: number;
  otherSessionPriority: number;
  tieBreak: string;
} {
  const sessionPriority = objectivePriority(sessionMetadata, policy);
  const otherSessionPriority = objectivePriority(otherSessionMetadata, policy);

  if (sessionPriority > otherSessionPriority) {
    return {
      preferredSessionId: sessionId,
      sessionPriority,
      otherSessionPriority,
      tieBreak: "objective_priority",
    };
  }
  if (otherSessionPriority > sessionPriority) {
    return {
      preferredSessionId: otherSessionId,
      sessionPriority,
      otherSessionPriority,
      tieBreak: "objective_priority",
    };
  }

  const sessionCreatedAt = sessionMetadata.createdAt;
  const otherCreatedAt =
    otherSessionMetadata?.createdAt ?? Number.MAX_SAFE_INTEGER;

  if (sessionCreatedAt < otherCreatedAt) {
    return {
      preferredSessionId: sessionId,
      sessionPriority,
      otherSessionPriority,
      tieBreak: "created_at",
    };
  }
  if (otherCreatedAt < sessionCreatedAt) {
    return {
      preferredSessionId: otherSessionId,
      sessionPriority,
      otherSessionPriority,
      tieBreak: "created_at",
    };
  }

  return {
    preferredSessionId:
      sessionId.localeCompare(otherSessionId) <= 0
        ? sessionId
        : otherSessionId,
    sessionPriority,
    otherSessionPriority,
    tieBreak: "session_id",
  };
}

export function resolveSessionArbitrationPolicy(
  input?: SessionArbitrationPolicyInput
): SessionArbitrationPolicy {
  const envDefaultMode = normalizeMode(
    process.env.RESIDUAL_ARBITRATION_MODE,
    "serialize_first"
  );
  const envEnabled = parseBooleanEnv(
    process.env.RESIDUAL_ARBITRATION_ENABLED,
    true
  );

  const modeByConflictType: Partial<
    Record<SessionConflictType, SessionArbitrationMode>
  > = {
    ...(process.env.RESIDUAL_ARBITRATION_WRITE_WRITE_MODE
      ? {
          write_write: normalizeMode(
            process.env.RESIDUAL_ARBITRATION_WRITE_WRITE_MODE,
            envDefaultMode
          ),
        }
      : {}),
    ...(process.env.RESIDUAL_ARBITRATION_READ_WRITE_MODE
      ? {
          read_write: normalizeMode(
            process.env.RESIDUAL_ARBITRATION_READ_WRITE_MODE,
            envDefaultMode
          ),
        }
      : {}),
    ...(input?.modeByConflictType ?? {}),
  };

  const objectiveTypePriority = {
    ...normalizeObjectiveTypePriority(DEFAULT_OBJECTIVE_TYPE_PRIORITY),
    ...normalizeObjectiveTypePriority(input?.objectiveTypePriority ?? {}),
  };

  return {
    enabled: input?.enabled ?? envEnabled,
    defaultMode: input?.defaultMode ?? envDefaultMode,
    modeByConflictType,
    objectiveTypePriority,
  };
}

export function arbitrateSessionConflicts(
  params: ArbitrationParams
): SessionArbitrationEvent[] {
  if (!params.policy.enabled || params.conflicts.length === 0) return [];

  const decisions: SessionArbitrationEvent[] = params.conflicts.map(
    (conflict) => {
      const mode =
        params.policy.modeByConflictType[conflict.conflictType] ??
        params.policy.defaultMode;
      const peerMetadata = params.peerMetadataBySessionId[conflict.otherSessionId];
      const preference = selectPreferredSession(
        params.sessionId,
        params.sessionMetadata,
        conflict.otherSessionId,
        peerMetadata,
        params.policy
      );
      const outcome =
        mode === "branch_split_required"
          ? "branch_split_required"
          : "serialize_wait";

      const priorityReason =
        preference.preferredSessionId === params.sessionId
          ? `session "${params.sessionId}" has precedence`
          : `session "${conflict.otherSessionId}" has precedence`;

      const modeReason =
        mode === "branch_split_required"
          ? "policy requires branch split for this conflict class"
          : "policy requires serialized execution for this conflict class";
      const conflictKey = `${conflict.conflictType}|${conflict.resource}|${conflict.otherSessionId}`;
      const freshnessMs = params.conflictFreshnessMsByKey?.[conflictKey];
      const freshnessReason =
        freshnessMs !== undefined
          ? `peer claim freshness=${Math.max(0, freshnessMs)}ms remaining`
          : undefined;

      const unblock =
        mode === "branch_split_required"
          ? [
              {
                kind: "split_scope" as const,
                detail: `Create separate branch/worktree scope before writing "${conflict.resource}".`,
              },
              {
                kind: "integration_action" as const,
                detail: `Add an integration action (merge/rebase/cherry-pick) after scope split for "${conflict.resource}".`,
              },
              {
                kind: "narrow_resource_sets" as const,
                detail: `Narrow overlapping readSet/writeSet declarations for "${conflict.resource}".`,
              },
            ]
          : [
              {
                kind: "wait_for_other_session" as const,
                detail: `Serialize after session "${conflict.otherSessionId}" completes its work on "${conflict.resource}".`,
              },
              {
                kind: "integration_action" as const,
                detail: `Plan an explicit integration action after serialized execution for "${conflict.resource}".`,
              },
              {
                kind: "narrow_resource_sets" as const,
                detail: `Narrow overlapping readSet/writeSet declarations for "${conflict.resource}".`,
              },
            ];

      return {
        kind: "session_arbitration",
        action: conflict.action,
        otherAction: conflict.otherAction,
        sessionId: params.sessionId,
        otherSessionId: conflict.otherSessionId,
        conflictType: conflict.conflictType,
        resource: conflict.resource,
        scope: conflict.scope,
        mode,
        outcome,
        preferredSessionId: preference.preferredSessionId,
        precedence: {
          conflictRank: CONFLICT_RANK[conflict.conflictType],
          sessionPriority: preference.sessionPriority,
          otherSessionPriority: preference.otherSessionPriority,
          tieBreak: preference.tieBreak,
        },
        reason: `${modeReason}; ${priorityReason} via ${preference.tieBreak} precedence.${freshnessReason ? ` ${freshnessReason}.` : ""}`,
        unblock,
      };
    }
  );

  return decisions.sort((left, right) => {
    if (left.precedence.conflictRank !== right.precedence.conflictRank) {
      return right.precedence.conflictRank - left.precedence.conflictRank;
    }
    if (left.resource !== right.resource) {
      return left.resource.localeCompare(right.resource);
    }
    if (left.otherSessionId !== right.otherSessionId) {
      return left.otherSessionId.localeCompare(right.otherSessionId);
    }
    return actionKey(left.otherAction).localeCompare(actionKey(right.otherAction));
  });
}
