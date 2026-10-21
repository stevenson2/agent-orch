import type { VendorConfig } from "../types.js";
import type { Spawner } from "../spawn.js";
import type { Adapter } from "./types.js";
import { AcpxAdapter } from "./acpx.js";
import { CommandAdapter } from "./command.js";
import { DshAdapter } from "./dsh.js";
import { ZCodeAdapter } from "./zcode.js";

export function createAdapter(vendor: VendorConfig, spawner: Spawner): Adapter {
  const common = {
    vendor: vendor.id,
    harness: vendor.harness,
    command: vendor.command,
    commandArgs: vendor.commandArgs,
    spawner,
    env: vendor.env,
    timeoutMs: vendor.timeoutMs,
  };
  switch (vendor.adapter) {
    case "zcode":
      return new ZCodeAdapter({
        ...common,
        outputFormat: vendor.outputFormat,
        executeMode: vendor.zcodeExecuteMode,
      });
    case "dsh":
      return new DshAdapter(common);
    case "acpx":
      if (!vendor.acpxAgent) {
        throw new Error(`vendor ${vendor.id} uses acpx but has no acpx_agent`);
      }
      return new AcpxAdapter({ ...common, acpxAgent: vendor.acpxAgent });
    case "command":
      return new CommandAdapter({
        ...common,
        args: vendor.args,
        modeArgs: vendor.modeArgs,
      });
    default:
      throw new Error(`unsupported adapter ${(vendor as VendorConfig).adapter}`);
  }
}

export function createAdapters(vendors: VendorConfig[], spawner: Spawner): Map<string, Adapter> {
  const map = new Map<string, Adapter>();
  for (const vendor of vendors) {
    map.set(vendor.id, createAdapter(vendor, spawner));
  }
  return map;
}
