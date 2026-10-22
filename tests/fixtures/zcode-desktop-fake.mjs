#!/usr/bin/env node
// Speaks the subset of ZCode app-server NDJSON that the zcode-desktop adapter drives.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const cwdFlag = process.argv.indexOf("--cwd");
if (cwdFlag >= 0 && process.argv[cwdFlag + 1]) process.chdir(process.argv[cwdFlag + 1]);

const vendor = process.env.ORCH_FAKE_VENDOR ?? "fake";
const statePath = process.env.ORCH_FAKE_STATE;

function loadState() {
  if (!statePath || !fs.existsSync(statePath)) return { hits: {} };
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function saveState(state) {
  if (!statePath) return;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
}

const state = loadState();
state.hits[vendor] = (state.hits[vendor] ?? 0) + 1;
const limitOnce = (process.env.ORCH_FAKE_429_VENDORS ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (limitOnce.includes(vendor) && state.hits[vendor] === 1) {
  saveState(state);
  process.stderr.write("429 rate limit exceeded\n");
  process.stdout.write(
    `${JSON.stringify({
      method: "startup/storageState",
      params: {
        schemaVersion: 1,
        attemptId: "limit",
        sequence: 1,
        databaseId: "db",
        databaseKind: "session",
        phase: "failed",
        elapsedMs: 1,
        errorCode: "429 rate limit exceeded",
      },
    })}\n`,
    () => process.exit(1),
  );
} else {
saveState(state);

send({
  method: "startup/storageState",
  params: {
    schemaVersion: 1,
    attemptId: "ok",
    sequence: 1,
    databaseId: "db",
    databaseKind: "session",
    phase: "ready",
    elapsedMs: 1,
  },
});

let prompt = "";
let sessionId = "";

function snapshot(phase, text) {
  send({
    method: "v4/conversation/frame",
    params: {
      wireVersion: 3,
      kind: "complete",
      deliveryKind: "initial",
      logicalFrameId: "frame-1",
      logicalFrameOrdinal: 1,
      topic: `conversation/${sessionId}`,
      subscriptionId: "sub-1",
      frame: {
        topic: `conversation/${sessionId}`,
        subscriptionId: "sub-1",
        fromSeq: 0,
        toSeq: 2,
        sentAt: Date.now(),
        payload: {
          kind: "snapshot",
          snapshot: {
            control: {
              phase,
              activeWorks: [],
              lastError: phase === "error" ? { message: text } : null,
            },
            rows: [
              {
                rowId: 1,
                kind: "assistantText",
                text,
                state: "complete",
              },
            ],
            usage: {
              cumulative: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          },
        },
      },
    },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "v4/command" && message.params?.type === "createSession") {
    sessionId = "sess-desktop";
    prompt = message.params.payload?.firstInput?.text ?? "";
    send({
      id: message.id,
      result: {
        commandId: message.params.commandId,
        status: "accepted",
        revisionAtDecision: 1,
        result: { type: "createSession", sessionId },
      },
    });
    return;
  }
  if (message.method === "v4/conversation/subscribe") {
    if (/hello\.txt/.test(prompt)) {
      fs.writeFileSync(path.join(process.cwd(), "hello.txt"), "hello\n");
    }
    send({
      id: message.id,
      result: { ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" } },
    });
    send({
      id: "perm-1",
      method: "interaction/requestPermission",
      params: { toolName: "Read", options: [{ response: { decision: "allow" } }] },
    });
    return;
  }
  if (message.id === "perm-1") {
    snapshot("completedSuccess", "created hello.txt");
    rl.close();
  }
});
}
