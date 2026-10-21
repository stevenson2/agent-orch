import path from "node:path";
import { appendJsonl, atomicWriteJson, readJsonl } from "./jsonl.js";
import { NOTABLE_EVENTS, type OrchEvent, type RunState } from "./types.js";

interface SnapshotLine {
  ts: string;
  kind: "snapshot";
  state: RunState;
}

export class RunStore {
  constructor(private readonly artifactsDir: string) {}

  runDir(runId: string): string {
    return path.join(this.artifactsDir, "runs", runId);
  }

  eventsFile(runId: string): string {
    return path.join(this.runDir(runId), "events.jsonl");
  }

  stateLog(runId: string): string {
    return path.join(this.runDir(runId), "state.jsonl");
  }

  notableFile(): string {
    return path.join(this.artifactsDir, "events.jsonl");
  }

  /** Append-only snapshot log plus a latest state.json for quick reads. */
  async appendSnapshot(state: RunState): Promise<void> {
    const line: SnapshotLine = { ts: state.updatedAt, kind: "snapshot", state };
    await appendJsonl(this.stateLog(state.id), line);
    await atomicWriteJson(path.join(this.runDir(state.id), "state.json"), state);
  }

  async appendEvent(event: OrchEvent): Promise<void> {
    await appendJsonl(this.eventsFile(event.runId), event);
    if (NOTABLE_EVENTS.has(event.type as never)) {
      await appendJsonl(this.notableFile(), event);
    }
  }

  async usageFile(runId: string): Promise<string> {
    return path.join(this.runDir(runId), "usage.jsonl");
  }
}

export async function readRunState(artifactsDir: string, runId: string): Promise<RunState | null> {
  const dir = path.join(artifactsDir, "runs", runId);
  try {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path.join(dir, "state.json"), "utf8");
    return JSON.parse(text) as RunState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = await readJsonl<SnapshotLine>(path.join(dir, "state.jsonl"));
  return lines.length > 0 ? lines[lines.length - 1].state : null;
}

export async function listRunStates(artifactsDir: string): Promise<RunState[]> {
  const { readdir } = await import("node:fs/promises");
  let names: string[];
  try {
    names = await readdir(path.join(artifactsDir, "runs"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const states: RunState[] = [];
  for (const name of names) {
    const state = await readRunState(artifactsDir, name);
    if (state) states.push(state);
  }
  states.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return states;
}

export async function readNotableEvents(artifactsDir: string): Promise<OrchEvent[]> {
  return readJsonl<OrchEvent>(path.join(artifactsDir, "events.jsonl"));
}
