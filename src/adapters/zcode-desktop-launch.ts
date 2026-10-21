import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DesktopLaunchInput {
  command: string;
  commandArgs: string[];
  cwd: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (file: string) => boolean;
}

export interface DesktopLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Absolute agent bundle when one was found. Absent for an explicit script entry. */
  bundle?: string;
}

const SCRIPT_EXT = /\.(?:mjs|cjs|js)$/i;

/** Same names the desktop Host passes via createNodeProviderRuntimePathEnv. */
export const ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";
export const ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path;
}

function existsFile(file: string, exists: (file: string) => boolean): boolean {
  try {
    return exists(file);
  } catch {
    return false;
  }
}

function bundleBeside(executable: string, platform: NodeJS.Platform): string[] {
  const p = pathApi(platform);
  const dir = p.dirname(executable);
  return [
    p.join(dir, "resources", "glm", "zcode.cjs"),
    p.join(dir, "Resources", "glm", "zcode.cjs"),
    p.normalize(p.join(dir, "..", "Resources", "glm", "zcode.cjs")),
    p.normalize(p.join(dir, "..", "resources", "glm", "zcode.cjs")),
  ];
}

export function desktopInstallCandidates(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  const p = pathApi(platform);
  const local = env.LOCALAPPDATA ?? p.join(home, "AppData", "Local");
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  if (platform === "win32") {
    return [
      p.join(local, "Programs", "ZCode", "ZCode.exe"),
      p.join(local, "Programs", "zcode", "ZCode.exe"),
      p.join(local, "ZCode", "ZCode.exe"),
      p.join(programFiles, "ZCode", "ZCode.exe"),
      p.join(programFilesX86, "ZCode", "ZCode.exe"),
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/ZCode.app/Contents/MacOS/ZCode",
      path.posix.join(home, "Applications", "ZCode.app", "Contents", "MacOS", "ZCode"),
    ];
  }
  return [
    "/opt/ZCode/zcode",
    "/opt/ZCode/ZCode",
    "/usr/bin/zcode",
    path.posix.join(home, ".local", "bin", "zcode"),
    path.posix.join(home, ".local", "share", "ZCode", "zcode"),
  ];
}

/**
 * Packaged layout is resources/glm/zcode.cjs beside resources/config/provider/zcode-builtin.json.
 * The CLI's own fallback is resources/glm/provider and a five-level walk to the monorepo
 * config/ directory. From a desktop install that walk lands on AppData/config, which is not a file.
 */
export function bundledBuiltinProviderConfig(bundle: string, platform: NodeJS.Platform): string {
  const p = pathApi(platform);
  const resourcesDir = p.dirname(p.dirname(bundle));
  return p.join(resourcesDir, "config", "provider", "zcode-builtin.json");
}

/** Host personal config: {dataBaseDir}/.zcode/v2/provider_config.json. dataBaseDir is home, not AppData. */
export function personalProviderConfigPath(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const p = pathApi(platform);
  const base = env.ZCODE_DATA_BASE_DIR?.trim() || home;
  return p.join(base, ".zcode", "v2", "provider_config.json");
}

function hostProviderEnv(
  bundle: string,
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
  exists: (file: string) => boolean,
): Record<string, string> {
  const provider = bundledBuiltinProviderConfig(bundle, platform);
  if (!existsFile(provider, exists)) return {};
  const out: Record<string, string> = {};
  if (!env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE]?.trim()) {
    out[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE] = provider;
  }
  if (!env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE]?.trim()) {
    out[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE] = personalProviderConfigPath(home, env, platform);
  }
  return out;
}

/**
 * Official desktop Host launch, from packages/services zcodeAgentProcessManager:
 * ELECTRON_RUN_AS_NODE=1 <electron> resources/glm/zcode.cjs app-server --stdio --surface desktop
 * The Host also sets ZCODE_BUILTIN_PROVIDER_CONFIG_FILE and ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
 * so app-server does not guess the provider file from the glm bundle path.
 */
export function resolveDesktopLaunch(input: DesktopLaunchInput): DesktopLaunch | { error: string } {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  const exists = input.exists ?? fs.existsSync;
  const scriptArg = input.commandArgs.find((arg) => SCRIPT_EXT.test(arg));
  if (scriptArg) {
    const before = input.commandArgs.slice(0, input.commandArgs.indexOf(scriptArg));
    const after = input.commandArgs.slice(input.commandArgs.indexOf(scriptArg) + 1);
    return {
      command: input.command,
      args: [...before, scriptArg, ...after, "app-server", "--stdio", "--surface", "desktop", "--cwd", input.cwd],
      env: hostProviderEnv(scriptArg, platform, home, env, exists),
    };
  }

  const candidates: string[] = [];
  if (input.command && !["ZCode", "zcode", "ZCode.exe"].includes(input.command)) {
    candidates.push(input.command);
  }
  candidates.push(...desktopInstallCandidates(platform, home, env));

  for (const candidate of candidates) {
    if (SCRIPT_EXT.test(candidate) && existsFile(candidate, exists)) {
      return {
        command: process.execPath,
        args: [candidate, "app-server", "--stdio", "--surface", "desktop", "--cwd", input.cwd],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          ...hostProviderEnv(candidate, platform, home, env, exists),
        },
        bundle: candidate,
      };
    }
    if (!existsFile(candidate, exists)) continue;
    const bundles = bundleBeside(candidate, platform);
    const bundle = bundles.find((file) => existsFile(file, exists));
    if (!bundle) continue;
    return {
      command: candidate,
      args: [bundle, "app-server", "--stdio", "--surface", "desktop", "--cwd", input.cwd],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        ...hostProviderEnv(bundle, platform, home, env, exists),
      },
      bundle,
    };
  }

  return {
    error:
      "没有找到官方 ZCode 桌面安装（resources/glm/zcode.cjs）。桌面窗口没有可附着的本地端口；把 command 指到 ZCode 可执行文件，或把 command_args 指到 zcode.cjs。",
  };
}
