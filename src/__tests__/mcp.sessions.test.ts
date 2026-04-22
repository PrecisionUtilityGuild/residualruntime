import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../mcp/sessions";
import { DatabaseSync } from "node:sqlite";
import { step } from "../runtime/engine";
import { createFileLog } from "../runtime/fileAdapter";
import { createEmptyResidual, createInitialState } from "../runtime/model";
import { appendStep } from "../runtime/store";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "residual-mcp-sessions-"));
}

test("SessionManager persists session steps and can reload state from log", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    const created = manager.newSession({ sessionId: "shared-room" });
    assert.equal(created.sessionId, "shared-room");
    assert.equal(created.stepCount, 0);
    assert.equal(created.metadata.status, "active");

    const unresolved = { type: "Unresolved" as const, phi1: "x=true", phi2: "x=false" };
    const action = { kind: "action" as const, type: "USE_X_TRUE", dependsOn: ["x=true"] };

    const blockedStep = manager.stepSession("shared-room", {
      input: { constraints: [unresolved] },
      proposals: [action],
    });

    assert.equal(blockedStep.actionsApproved.length, 0);
    assert.equal(blockedStep.actionsBlocked.length, 1);

    const snapshotAfterBlock = manager.getState("shared-room");
    assert.equal(snapshotAfterBlock.stepCount, 1);
    assert.equal(snapshotAfterBlock.residual.tensions.length, 1);

    const restartedManager = new SessionManager(dir);
    const snapshotAfterReload = restartedManager.getState("shared-room");
    assert.equal(snapshotAfterReload.stepCount, 1);
    assert.equal(snapshotAfterReload.residual.tensions.length, 1);
    assert.equal(snapshotAfterReload.metadata.status, "active");

    const adjudicatedStep = restartedManager.stepSession("shared-room", {
      input: { adjudications: [{ phi1: "x=true", phi2: "x=false", winner: "x=true" }] },
      proposals: [action],
    });

    assert.equal(adjudicatedStep.actionsApproved.length, 1);
    assert.equal(adjudicatedStep.actionsBlocked.length, 0);

    const listing = restartedManager.listSessions();
    assert.equal(listing.length, 1);
    assert.equal(listing[0].sessionId, "shared-room");
    assert.equal(listing[0].stepCount, 2);
    assert.equal(listing[0].metadata.status, "active");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager can seed a new session with initial proposals", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    const seeded = manager.newSession({
      sessionId: "seeded",
      seedProposals: [{ kind: "evidence_gap", phi: "signal", threshold: 0.9 }],
    });

    assert.equal(seeded.sessionId, "seeded");
    assert.equal(seeded.stepCount, 1);

    const state = manager.getState("seeded");
    assert.equal(state.residual.evidenceGaps.length, 1);
    assert.equal(state.residual.evidenceGaps[0].phi, "signal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager persists objective metadata and step context", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    const created = manager.newSession({
      sessionId: "ticket-123",
      metadata: {
        objectiveType: "ticket",
        objectiveRef: "JIRA-123",
        title: "Fix deploy gate",
      },
    });

    assert.equal(created.metadata.objectiveType, "ticket");
    assert.equal(created.metadata.objectiveRef, "JIRA-123");
    assert.equal(created.metadata.title, "Fix deploy gate");
    assert.equal(created.metadata.status, "active");
    assert.equal(created.lastEventContext, undefined);

    manager.stepSession("ticket-123", {
      context: {
        branch: "feature/jira-123",
        commitSha: "abc123",
        actorId: "agent-a",
      },
      proposals: [{ kind: "action", type: "NO_OP" }],
    });

    const restartedManager = new SessionManager(dir);
    const snapshotAfterReload = restartedManager.getState("ticket-123");
    assert.equal(snapshotAfterReload.metadata.objectiveType, "ticket");
    assert.equal(snapshotAfterReload.metadata.objectiveRef, "JIRA-123");
    assert.equal(snapshotAfterReload.lastEventContext?.branch, "feature/jira-123");
    assert.equal(snapshotAfterReload.lastEventContext?.actorId, "agent-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager defaults to sqlite WAL store with required indexes", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    manager.newSession({ sessionId: "sqlite-check" });
    const dbPath = manager.getLogPath("sqlite-check");

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const mode = db.prepare("PRAGMA journal_mode").get() as
        | { journal_mode?: string }
        | undefined;
      assert.equal((mode?.journal_mode ?? "").toLowerCase(), "wal");

      const indexes = db
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'session_events'`
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((row) => row.name);
      assert.ok(indexNames.includes("idx_session_events_session_step"));
      assert.ok(indexNames.includes("idx_session_events_recorded_at"));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager imports legacy ndjson sessions into sqlite", () => {
  const dir = makeTmpDir();

  try {
    const legacySessionId = "legacy-room";
    const legacyLogPath = join(dir, `${encodeURIComponent(legacySessionId)}.ndjson`);
    const legacyMetadataPath = join(
      dir,
      `${encodeURIComponent(legacySessionId)}.meta.json`
    );

    const legacyLog = createFileLog(legacyLogPath);
    const initialState = createInitialState();
    const initialResidual = createEmptyResidual();
    const firstStep = step({
      state: initialState,
      residual: initialResidual,
      input: { constraints: [{ type: "Unresolved", phi1: "x=true", phi2: "x=false" }] },
      proposals: [{ kind: "action", type: "USE_X_TRUE", dependsOn: ["x=true"] }],
    });

    appendStep(legacyLog, {
      ...firstStep.replay,
      context: {
        branch: "legacy/branch",
        actorId: "legacy-agent",
      },
    });

    writeFileSync(
      legacyMetadataPath,
      `${JSON.stringify(
        {
          objectiveType: "ticket",
          objectiveRef: "LEG-7",
          title: "Legacy migration sample",
          status: "active",
          createdAt: 1700000000000,
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const manager = new SessionManager(dir);
    const importResult = manager.importLegacyNdjsonSessions();
    assert.equal(importResult.scanned, 1);
    assert.equal(importResult.imported, 1);
    assert.equal(importResult.skippedExisting, 0);
    assert.equal(importResult.importedEvents, 1);

    const snapshot = manager.getState(legacySessionId);
    assert.equal(snapshot.stepCount, 1);
    assert.equal(snapshot.residual.tensions.length, 1);
    assert.equal(snapshot.metadata.objectiveRef, "LEG-7");
    assert.equal(snapshot.lastEventContext?.branch, "legacy/branch");

    const secondImport = manager.importLegacyNdjsonSessions();
    assert.equal(secondImport.scanned, 1);
    assert.equal(secondImport.imported, 0);
    assert.equal(secondImport.skippedExisting, 1);
    assert.equal(secondImport.importedEvents, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager blocks write/write overlap across active sessions in the same branch", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    manager.newSession({ sessionId: "ticket-a" });
    manager.newSession({ sessionId: "ticket-b" });

    const first = manager.stepSession("ticket-a", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "EDIT_USERS", writeSet: ["db:users"] }],
    });
    assert.equal(first.actionsApproved.length, 1);

    const second = manager.stepSession("ticket-b", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "MIGRATE_USERS", writeSet: ["db:users"] }],
    });

    assert.equal(second.actionsApproved.length, 0);
    assert.equal(second.actionsBlocked.length, 1);
    assert.equal(second.sessionArbitrationPolicy.enabled, true);
    assert.equal(second.sessionArbitrationPolicy.defaultMode, "serialize_first");
    assert.equal(second.sessionConflicts.length, 1);
    assert.equal(second.sessionArbitrations.length, 1);
    assert.equal(second.sessionArbitrations[0].mode, "serialize_first");
    assert.equal(second.sessionArbitrations[0].outcome, "serialize_wait");
    assert.equal(second.sessionConflicts[0].conflictType, "write_write");
    assert.equal(second.sessionConflicts[0].resource, "db:users");
    assert.equal(second.sessionConflicts[0].otherSessionId, "ticket-a");
    assert.equal(second.blockedWith.length, 1);
    assert.ok(
      second.blockedWith[0].blockedBy.some((marker) =>
        marker.includes(
          "session_arbitration:serialize_first:serialize_wait:db:users:ticket-a"
        )
      )
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager blocks read/write overlap across active sessions in the same branch", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    manager.newSession({ sessionId: "ticket-a" });
    manager.newSession({ sessionId: "ticket-b" });

    manager.stepSession("ticket-a", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "WRITE_PROFILE", writeSet: ["profile:42"] }],
    });

    const reader = manager.stepSession("ticket-b", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "READ_PROFILE", readSet: ["profile:42"] }],
    });

    assert.equal(reader.actionsApproved.length, 0);
    assert.equal(reader.actionsBlocked.length, 1);
    assert.equal(reader.sessionConflicts.length, 1);
    assert.equal(reader.sessionArbitrations.length, 1);
    assert.equal(reader.sessionConflicts[0].conflictType, "read_write");
    assert.equal(reader.sessionConflicts[0].resource, "profile:42");
    assert.equal(reader.sessionConflicts[0].otherSessionId, "ticket-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager allows non-conflicting parallel actions in the same branch", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    manager.newSession({ sessionId: "ticket-a" });
    manager.newSession({ sessionId: "ticket-b" });

    manager.stepSession("ticket-a", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "WRITE_A", writeSet: ["resource:a"] }],
    });

    const second = manager.stepSession("ticket-b", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "WRITE_B", writeSet: ["resource:b"] }],
    });

    assert.equal(second.actionsApproved.length, 1);
    assert.equal(second.actionsBlocked.length, 0);
    assert.equal(second.sessionConflicts.length, 0);
    assert.equal(second.sessionArbitrations.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager supports branch-split-required arbitration mode override", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    manager.newSession({ sessionId: "ticket-a" });
    manager.newSession({ sessionId: "ticket-b" });

    manager.stepSession("ticket-a", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "WRITE_SHARED", writeSet: ["resource:shared"] }],
    });

    const second = manager.stepSession("ticket-b", {
      context: { branch: "feature/shared" },
      arbitrationPolicy: { defaultMode: "branch_split_required" },
      proposals: [{ kind: "action", type: "WRITE_SHARED_2", writeSet: ["resource:shared"] }],
    });

    assert.equal(second.actionsApproved.length, 0);
    assert.equal(second.actionsBlocked.length, 1);
    assert.equal(second.sessionArbitrations.length, 1);
    assert.equal(second.sessionArbitrationPolicy.defaultMode, "branch_split_required");
    assert.equal(second.sessionArbitrations[0].mode, "branch_split_required");
    assert.equal(second.sessionArbitrations[0].outcome, "branch_split_required");
    assert.ok(
      second.sessionArbitrations[0].unblock.some(
        (step) => step.kind === "split_scope"
      )
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager can disable cross-session arbitration gate for rollback", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    manager.newSession({ sessionId: "ticket-a" });
    manager.newSession({ sessionId: "ticket-b" });

    manager.stepSession("ticket-a", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "WRITE_SHARED", writeSet: ["resource:shared"] }],
    });

    const second = manager.stepSession("ticket-b", {
      context: { branch: "feature/shared" },
      arbitrationPolicy: { enabled: false },
      proposals: [{ kind: "action", type: "WRITE_SHARED_2", writeSet: ["resource:shared"] }],
    });

    assert.equal(second.sessionArbitrationPolicy.enabled, false);
    assert.equal(second.actionsApproved.length, 1);
    assert.equal(second.actionsBlocked.length, 0);
    assert.equal(second.sessionConflicts.length, 0);
    assert.equal(second.sessionArbitrations.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager reports deterministic error for stale concurrent writers", () => {
  const dir = makeTmpDir();

  try {
    const managerA = new SessionManager(dir);
    managerA.newSession({ sessionId: "shared-room" });

    const managerB = new SessionManager(dir);
    managerB.getState("shared-room");

    managerA.stepSession("shared-room", {
      proposals: [{ kind: "action", type: "STEP_A" }],
    });

    assert.throws(
      () =>
        managerB.stepSession("shared-room", {
          proposals: [{ kind: "action", type: "STEP_B" }],
        }),
      /Concurrent session update detected for "shared-room"/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager root resolution prefers explicit root over env root", () => {
  const dir = makeTmpDir();
  const explicitRoot = join(dir, "explicit-root");
  const envRoot = join(dir, "env-root");
  const prior = process.env.RESIDUAL_SESSION_ROOT_DIR;

  try {
    process.env.RESIDUAL_SESSION_ROOT_DIR = envRoot;
    const explicitManager = new SessionManager(explicitRoot);
    assert.equal(explicitManager.rootPath, explicitRoot);

    const envManager = new SessionManager();
    assert.equal(envManager.rootPath, envRoot);
  } finally {
    if (prior === undefined) delete process.env.RESIDUAL_SESSION_ROOT_DIR;
    else process.env.RESIDUAL_SESSION_ROOT_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager arbitration uses session_id tie-break when priorities and createdAt are equal", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    manager.newSession({
      sessionId: "ticket-a",
      metadata: { objectiveType: "ticket", createdAt: 42 },
    });
    manager.newSession({
      sessionId: "ticket-b",
      metadata: { objectiveType: "ticket", createdAt: 42 },
    });

    manager.stepSession("ticket-a", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "WRITE_SHARED", writeSet: ["resource:shared"] }],
    });

    const second = manager.stepSession("ticket-b", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "WRITE_SHARED_2", writeSet: ["resource:shared"] }],
    });

    assert.equal(second.sessionArbitrations.length, 1);
    assert.equal(second.sessionArbitrations[0].preferredSessionId, "ticket-a");
    assert.equal(second.sessionArbitrations[0].precedence.tieBreak, "session_id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager conflict-class mode override takes precedence over default mode", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    manager.newSession({ sessionId: "ticket-a" });
    manager.newSession({ sessionId: "ticket-b" });

    manager.stepSession("ticket-a", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "WRITE_SHARED", writeSet: ["resource:shared"] }],
    });

    const second = manager.stepSession("ticket-b", {
      context: { branch: "feature/shared" },
      arbitrationPolicy: {
        defaultMode: "branch_split_required",
        modeByConflictType: { read_write: "serialize_first" },
      },
      proposals: [{ kind: "action", type: "READ_SHARED", readSet: ["resource:shared"] }],
    });

    assert.equal(second.sessionArbitrations.length, 1);
    assert.equal(second.sessionArbitrations[0].conflictType, "read_write");
    assert.equal(second.sessionArbitrations[0].mode, "serialize_first");
    assert.equal(second.sessionArbitrations[0].outcome, "serialize_wait");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionManager arbitration objectiveTypePriority keys are case-insensitive", () => {
  const dir = makeTmpDir();

  try {
    const manager = new SessionManager(dir);
    manager.newSession({
      sessionId: "ticket-a",
      metadata: { objectiveType: "incident" },
    });
    manager.newSession({
      sessionId: "ticket-b",
      metadata: { objectiveType: "ticket" },
    });

    manager.stepSession("ticket-a", {
      context: { branch: "feature/shared" },
      proposals: [{ kind: "action", type: "WRITE_SHARED", writeSet: ["resource:shared"] }],
    });

    const second = manager.stepSession("ticket-b", {
      context: { branch: "feature/shared" },
      arbitrationPolicy: {
        objectiveTypePriority: { INCIDENT: 600, ticket: 500 },
      },
      proposals: [{ kind: "action", type: "WRITE_SHARED_2", writeSet: ["resource:shared"] }],
    });

    assert.equal(second.sessionArbitrations.length, 1);
    assert.equal(second.sessionArbitrations[0].preferredSessionId, "ticket-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
