import type { Config, Role, VendorConfig } from "./types.js";
import type { QuotaStore } from "./quota.js";

export interface Selection {
  vendor: VendorConfig;
  effectiveCostPer1k: number;
  remainingRatio: number;
  score: number;
}

export interface RankOptions {
  excludeVendors?: string[];
  at?: Date;
}

/**
 * Lower score wins.
 * effectiveCost = listCostPer1k / subscriptionMultiplier
 * score = effectiveCost / max(remainingRatio, 0.05)
 *
 * A 1.5x in-harness subscription therefore ranks cheaper than the same list
 * price outside that harness. A vendor with no remaining tokens in any
 * configured window is ineligible. Preferred vendors sort ahead of others;
 * the rest stay in the list so a 429 can fail over.
 */
export class Router {
  constructor(
    private readonly config: Config,
    private readonly quota: QuotaStore,
  ) {}

  async rank(role: Role, options: RankOptions = {}): Promise<Selection[]> {
    const at = options.at ?? new Date();
    const exclude = new Set(options.excludeVendors ?? []);
    const prefer = new Set(this.config.roles[role].prefer);
    const ranked: Selection[] = [];
    for (const vendor of this.config.vendors) {
      if (!vendor.roles.includes(role)) continue;
      if (exclude.has(vendor.id)) continue;
      if ((await this.quota.cooling(vendor.id, at)).cooling) continue;
      const remainingRatio = await this.remainingRatio(vendor, at);
      if (remainingRatio <= 0) continue;
      const effectiveCostPer1k = vendor.listCostPer1kTokens / vendor.subscriptionMultiplier;
      const score = effectiveCostPer1k / Math.max(remainingRatio, 0.05);
      ranked.push({ vendor, effectiveCostPer1k, remainingRatio, score });
    }
    ranked.sort((a, b) => {
      const aPreferred = prefer.size > 0 && prefer.has(a.vendor.id) ? 0 : 1;
      const bPreferred = prefer.size > 0 && prefer.has(b.vendor.id) ? 0 : 1;
      if (prefer.size > 0 && aPreferred !== bPreferred) return aPreferred - bPreferred;
      if (a.score !== b.score) return a.score - b.score;
      return a.vendor.id.localeCompare(b.vendor.id);
    });
    return ranked;
  }

  async select(role: Role, options: RankOptions = {}): Promise<Selection | undefined> {
    const ranked = await this.rank(role, options);
    return ranked[0];
  }

  private async remainingRatio(vendor: VendorConfig, at: Date): Promise<number> {
    if (vendor.quotas.length === 0) return 1;
    let min = 1;
    for (const window of vendor.quotas) {
      const used = await this.quota.usedTokens(vendor.id, window.windowSeconds, at);
      const remaining = (window.limitTokens - used) / window.limitTokens;
      if (remaining < min) min = remaining;
    }
    return min;
  }
}
