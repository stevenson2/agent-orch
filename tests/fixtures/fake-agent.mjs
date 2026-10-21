#!/usr/bin/env node
// Test double for vendor CLIs. Speaks the argv and stdout shapes the adapters expect.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flags = new Map();
const positionals = [];
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i];
  if (token === "--json" || token === "--approve-all" || token === "--approve-reads" || token === "--deny-all") {
    flags.set(token, "true");
    continue;
  }
  if (token.startsWith("--") || token === "-p") {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) {
      flags.set(token, "true");
    } else {
      flags.set(token, next);
      i += 1;
    }
    continue;
  }
  positionals.push(token);
}

const kind = flags.get("--kind") ?? "generic";
const prompt = flags.get("-p") ?? flags.get("--prompt") ?? positionals.at(-1) ?? "";
const cwdFlag = flags.get("--cwd");
if (cwdFlag) process.chdir(cwdFlag);

const vendor = process.env.ORCH_FAKE_VENDOR ?? "fake";
const statePath = process.env.ORCH_FAKE_STATE;

function loadState() {
  if (!statePath || !fs.existsSync(statePath)) return { reviews: {}, hits: {} };
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
if (limitOnce.includes(vendor) && state.hits[vendor] === 1) {
  saveState(state);
  process.stderr.write("429 rate limit exceeded\n");
  process.exit(1);
}

function field(name) {
  const match = prompt.match(new RegExp(`^${name}:\\s*(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

const role = field("ORCH_ROLE");
const taskId = field("ORCH_TASK_ID") || "task";
const replan = field("ORCH_REPLAN") === "1";
const usage = { input_tokens: 11, output_tokens: 7, total_tokens: 18 };
let text = "";

if (role === "planner") {
  if (process.env.ORCH_FAKE_PLANNER_TOUCHES === "1") {
    fs.writeFileSync(path.join(process.cwd(), "planner-touched.txt"), "nope\n");
  }
  const regionMatch = prompt.match(/USER_PLAN_BEGIN\n([\s\S]*?)\nUSER_PLAN_END/);
  const region = regionMatch ? regionMatch[1] : "";
  const fence = region.match(/```json\s*([\s\S]*?)```/);
  if (fence) {
    text = fence[1].trim();
  } else if (replan) {
    const current = prompt.match(/CURRENT_TASK:\n([\s\S]*)$/);
    const task = current ? JSON.parse(current[1]) : { id: taskId, title: "revised", instructions: "Create hello.txt containing exactly hello", acceptance: [] };
    if (!task.test_command && task.testCommand) task.test_command = task.testCommand;
    text = JSON.stringify({ tasks: [task] });
  } else {
    text = JSON.stringify({
      tasks: [
        {
          id: "hello",
          title: "Write hello",
          instructions: "Create hello.txt containing exactly hello",
          acceptance: ["hello.txt equals hello"],
          test_command:
            "node -e \"const fs=require('fs'); if (fs.readFileSync('hello.txt','utf8').trim()!=='hello') process.exit(1)\"",
        },
      ],
    });
  }
} else if (role === "executor") {
  if (/hello\.txt/.test(prompt)) {
    fs.writeFileSync(path.join(process.cwd(), "hello.txt"), "hello\n");
  } else {
    fs.writeFileSync(path.join(process.cwd(), "done.txt"), "done\n");
  }
  text = JSON.stringify({ ok: true, vendor });
} else if (role === "reviewer") {
  state.reviews[taskId] = (state.reviews[taskId] ?? 0) + 1;
  const always = process.env.ORCH_FAKE_ALWAYS_REJECT === "1";
  const passOnReplan = process.env.ORCH_FAKE_PASS_ON_REPLAN === "1" && replan;
  const pass = passOnReplan || (!always && state.reviews[taskId] >= 2);
  text = JSON.stringify(
    pass
      ? { verdict: "pass", reasons: ["acceptance met"], feedback: "" }
      : { verdict: "reject", reasons: ["need another pass"], feedback: "Write the file exactly as specified." },
  );
} else {
  text = "ok";
}

saveState(state);

if (kind === "dsh") {
  process.stdout.write(`${JSON.stringify({ type: "session", sessionId: "s1" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "text", text })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "final", text, reason: "completed", usage })}\n`);
} else if (kind === "acpx") {
  process.stdout.write(`${JSON.stringify({ type: "tool_call", title: "read" })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "message", text, usage })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "done", stopReason: "end_turn" })}\n`);
} else if (kind === "zcode" && flags.get("--output-format") === "stream-json") {
  process.stdout.write(`${JSON.stringify({ type: "assistant", text })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "result", response: text, usage })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ response: text, sessionId: "sess", usage }, null, 2)}\n`);
}
