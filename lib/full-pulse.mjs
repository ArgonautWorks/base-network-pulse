import { loadBasePulse } from "./base-pulse.mjs";
import { loadMarketPulse } from "./market-pulse.mjs";

export async function loadFullPulse({
  loadNetwork = loadBasePulse,
  loadMarket = loadMarketPulse,
} = {}) {
  const [networkResult, marketResult] = await Promise.allSettled([loadNetwork(), loadMarket()]);
  if (networkResult.status === "rejected") throw networkResult.reason;
  return {
    ...networkResult.value,
    market: marketResult.status === "fulfilled"
      ? marketResult.value
      : { status: "unavailable", observed_at: null, eth_usd: null, deepest_weth_stable_pool: null },
  };
}
