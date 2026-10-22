import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "enc:v1:";

export function credentialSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (configured) return configured;
  let username = "unknown";
  try {
    username = os.userInfo().username;
  } catch {
    username = "unknown";
  }
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
}

/** Same layout as apps/zcode-cli credential-cipher.ts: enc:v1:iv.tag.ciphertext, AES-256-GCM. */
export function decryptCredentialValue(value: string, secret: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const parts = value.slice(PREFIX.length).split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("Credential decrypt failed: invalid ciphertext format");
  }
  const iv = Buffer.from(parts[0], "base64url");
  const authTag = Buffer.from(parts[1], "base64url");
  const cipherText = Buffer.from(parts[2], "base64url");
  const key = createHash("sha256").update(secret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString("utf8");
}

export function credentialFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.ZCODE_DATA_BASE_DIR?.trim() || path.join(os.homedir(), ".zcode");
  return path.join(base, "v2", "credentials.json");
}

export interface LoadedCodingPlanKey {
  providerId: string;
  apiKey: string;
}

/**
 * Individual Coding Plan keys written by desktop and CLI login.
 * Key shape from standaloneAccountProviderCredentialKey:
 * account-provider:coding-plan:<providerId>:account:<identity>:api-key
 * Team and Start Plan material is resolved inside the desktop Host; this reader does not invent it.
 */
export function loadCodingPlanKeys(
  filePath: string,
  secret: string,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): LoadedCodingPlanKey[] {
  let raw: string;
  try {
    raw = readFile(filePath);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const keys: LoadedCodingPlanKey[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const match = name.match(/^account-provider:coding-plan:([^:]+):account:.+:api-key$/);
    if (!match || typeof value !== "string") continue;
    try {
      const apiKey = decryptCredentialValue(value, secret).trim();
      if (apiKey) keys.push({ providerId: decodeURIComponent(match[1] ?? ""), apiKey });
    } catch {
      continue;
    }
  }
  return keys;
}

export function selectCodingPlanKey(
  keys: LoadedCodingPlanKey[],
  providerId: string | undefined,
): LoadedCodingPlanKey | undefined {
  if (providerId) return keys.find((key) => key.providerId === providerId);
  return keys.length === 1 ? keys[0] : undefined;
}
