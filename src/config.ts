import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type {
  AdapterKind,
  AgentMode,
  Config,
  ExhaustPolicy,
  QuotaWindowConfig,
  Role,
  VendorConfig,
  ZCodeExecuteMode,
} from "./types.js";

const ROLES: Role[] = ["planner", "executor", "reviewer"];
const ADAPTERS: AdapterKind[] = ["zcode", "zcode-desktop", "dsh", "acpx", "command"];
const MODES: AgentMode[] = ["plan", "execute", "review"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function asNumber(value: unknown, label: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw new Error(`${label} is required`);
    return fallback;
  }
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  return n;
}

function asStringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a list of strings`);
  }
  return value;
}

function resolvePath(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

function parseQuotas(value: unknown, label: string): QuotaWindowConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${label}[${index}] must be a map`);
    const name = asString(item.name, `${label}[${index}].name`);
    const windowSeconds = asNumber(
      item.window_seconds ?? item.windowSeconds,
      `${label}[${index}].window_seconds`,
    );
    const limitTokens = asNumber(
      item.limit_tokens ?? item.limitTokens,
      `${label}[${index}].limit_tokens`,
    );
    if (windowSeconds <= 0 || limitTokens <= 0) {
      throw new Error(`${label}[${index}] window and limit must be positive`);
    }
    return { name, windowSeconds, limitTokens };
  });
}

function parseModeArgs(value: unknown, label: string): Partial<Record<AgentMode, string[]>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label} must be a map`);
  const out: Partial<Record<AgentMode, string[]>> = {};
  for (const mode of MODES) {
    if (value[mode] === undefined) continue;
    out[mode] = asStringList(value[mode], `${label}.${mode}`);
  }
  return out;
}

function parseVendor(id: string, value: unknown): VendorConfig {
  if (!isRecord(value)) throw new Error(`vendor ${id} must be a map`);
  const adapter = asString(value.adapter, `vendor ${id} adapter`) as AdapterKind;
  if (!ADAPTERS.includes(adapter)) {
    throw new Error(`vendor ${id} adapter must be one of ${ADAPTERS.join(", ")}`);
  }
  const roles = asStringList(value.roles, `vendor ${id} roles`) as Role[];
  if (roles.length === 0 || roles.some((role) => !ROLES.includes(role))) {
    throw new Error(`vendor ${id} roles must list planner, executor, and/or reviewer`);
  }
  const multiplier = asNumber(
    value.subscription_multiplier ?? value.subscriptionMultiplier,
    `vendor ${id} subscription_multiplier`,
    1,
  );
  if (multiplier <= 0) throw new Error(`vendor ${id} subscription_multiplier must be > 0`);
  const output = String(value.output_format ?? value.outputFormat ?? "json");
  if (output !== "json" && output !== "stream-json") {
    throw new Error(`vendor ${id} output_format must be json or stream-json`);
  }
  const executeMode = String(value.zcode_execute_mode ?? value.zcodeExecuteMode ?? "edit");
  if (executeMode !== "edit" && executeMode !== "yolo" && executeMode !== "build") {
    throw new Error(`vendor ${id} zcode_execute_mode must be edit, yolo, or build`);
  }
  const envRaw = value.env ?? {};
  if (!isRecord(envRaw)) throw new Error(`vendor ${id} env must be a map`);
  const env: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(envRaw)) {
    env[key] = String(envValue);
  }
  const enabledRaw = value.enabled;
  let enabled: boolean;
  if (typeof enabledRaw === "boolean") enabled = enabledRaw;
  else if (enabledRaw === undefined) enabled = adapter !== "zcode";
  else throw new Error(`vendor ${id} enabled must be a boolean`);
  return {
    id,
    harness: asString(value.harness ?? id, `vendor ${id} harness`),
    enabled,
    adapter,
    command: asString(value.command, `vendor ${id} command`),
    commandArgs: asStringList(value.command_args ?? value.commandArgs, `vendor ${id} command_args`),
    args: asStringList(value.args, `vendor ${id} args`),
    modeArgs: parseModeArgs(value.mode_args ?? value.modeArgs, `vendor ${id} mode_args`),
    acpxAgent:
      value.acpx_agent !== undefined || value.acpxAgent !== undefined
        ? asString(value.acpx_agent ?? value.acpxAgent, `vendor ${id} acpx_agent`)
        : undefined,
    outputFormat: output,
    zcodeExecuteMode: executeMode as ZCodeExecuteMode,
    subscriptionMultiplier: multiplier,
    listCostPer1kTokens: asNumber(
      value.list_cost_per_1k_tokens ?? value.listCostPer1kTokens,
      `vendor ${id} list_cost_per_1k_tokens`,
      0,
    ),
    roles,
    quotas: parseQuotas(value.quotas, `vendor ${id} quotas`),
    cooldownSeconds: asNumber(
      value.cooldown_seconds ?? value.cooldownSeconds,
      `vendor ${id} cooldown_seconds`,
      900,
    ),
    timeoutMs: asNumber(value.timeout_ms ?? value.timeoutMs, `vendor ${id} timeout_ms`, 600_000),
    env,
  };
}

function parseRolePrefer(raw: unknown, role: Role): string[] {
  if (!isRecord(raw) || raw[role] === undefined) return [];
  const block = raw[role];
  if (!isRecord(block)) throw new Error(`roles.${role} must be a map`);
  return asStringList(block.prefer, `roles.${role}.prefer`);
}

export function normalizeConfig(raw: unknown, baseDir: string, workspaceOverride?: string): Config {
  if (!isRecord(raw)) throw new Error("config must be a map");
  const version = asNumber(raw.version ?? 1, "version", 1);
  if (version !== 1) throw new Error("only config version 1 is supported");
  const workspace = resolvePath(
    baseDir,
    workspaceOverride ?? String(raw.workspace ?? "."),
  );
  const artifactsDir = resolvePath(
    workspace,
    String(raw.artifacts_dir ?? raw.artifactsDir ?? ".orch"),
  );
  const onExhaust = String(raw.on_exhaust ?? raw.onExhaust ?? "human") as ExhaustPolicy;
  if (onExhaust !== "human" && onExhaust !== "planner") {
    throw new Error("on_exhaust must be planner or human");
  }
  const maxReviewRounds = asNumber(
    raw.max_review_rounds ?? raw.maxReviewRounds,
    "max_review_rounds",
    2,
  );
  if (!Number.isInteger(maxReviewRounds) || maxReviewRounds < 1) {
    throw new Error("max_review_rounds must be an integer >= 1");
  }
  const vendorsRaw = raw.vendors;
  if (!isRecord(vendorsRaw)) throw new Error("vendors must be a map of vendor id -> settings");
  const vendors = Object.entries(vendorsRaw).map(([id, value]) => parseVendor(id, value));
  if (vendors.length === 0) throw new Error("at least one vendor is required");
  const ids = new Set<string>();
  for (const vendor of vendors) {
    if (ids.has(vendor.id)) throw new Error(`duplicate vendor ${vendor.id}`);
    ids.add(vendor.id);
    if (vendor.adapter === "acpx" && !vendor.acpxAgent) {
      throw new Error(`vendor ${vendor.id} requires acpx_agent`);
    }
  }
  let webhook: Config["webhook"];
  if (raw.webhook !== undefined) {
    if (!isRecord(raw.webhook)) throw new Error("webhook must be a map");
    const url = raw.webhook.url === undefined || raw.webhook.url === ""
      ? undefined
      : asString(raw.webhook.url, "webhook.url");
    webhook = {
      url,
      timeoutMs: asNumber(raw.webhook.timeout_ms ?? raw.webhook.timeoutMs, "webhook.timeout_ms", 5000),
    };
  }
  const testCommandRaw = raw.test_command ?? raw.testCommand;
  return {
    version: 1,
    workspace,
    artifactsDir,
    maxReviewRounds,
    onExhaust,
    testCommand: typeof testCommandRaw === "string" && testCommandRaw.trim() ? testCommandRaw.trim() : undefined,
    webhook,
    roles: {
      planner: { prefer: parseRolePrefer(raw.roles, "planner") },
      executor: { prefer: parseRolePrefer(raw.roles, "executor") },
      reviewer: { prefer: parseRolePrefer(raw.roles, "reviewer") },
    },
    vendors,
  };
}

export async function loadConfig(file: string, workspaceOverride?: string): Promise<Config> {
  const abs = path.resolve(file);
  const text = await fs.readFile(abs, "utf8");
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new Error(`failed to parse ${abs}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeConfig(raw, path.dirname(abs), workspaceOverride);
}
