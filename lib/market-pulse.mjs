export const COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/ETH-USD/spot";
export const BASE_WETH = "0x4200000000000000000000000000000000000006";
export const DEXSCREENER_PAIRS_URL = `https://api.dexscreener.com/token-pairs/v1/base/${BASE_WETH}`;

const STABLE_QUOTES = new Map([
  ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "USDC"],
  ["0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", "USDbC"],
  ["0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", "USDT"],
]);

function positiveNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} was not positive`);
  return number;
}

function optionalNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function fetchCoinbase(fetchImpl, timeoutMs) {
  const startedAt = Date.now();
  const response = await fetchImpl(COINBASE_SPOT_URL, {
    headers: { Accept: "application/json", "User-Agent": "ArgonautWorks/base-network-pulse" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Coinbase returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.data?.base !== "ETH" || body?.data?.currency !== "USD") {
    throw new Error("Coinbase returned the wrong market");
  }
  return {
    name: "coinbase",
    price_usd: positiveNumber(body.data.amount, "Coinbase ETH price"),
    latency_ms: Date.now() - startedAt,
  };
}

function stableWethPair(pair) {
  const quoteAddress = String(pair?.quoteToken?.address ?? "").toLowerCase();
  return pair?.chainId === "base"
    && pair?.baseToken?.address?.toLowerCase() === BASE_WETH.toLowerCase()
    && STABLE_QUOTES.has(quoteAddress)
    && String(pair?.quoteToken?.symbol ?? "").toUpperCase() === STABLE_QUOTES.get(quoteAddress).toUpperCase()
    && Number(pair?.liquidity?.usd) > 0
    && Number(pair?.priceUsd) > 0;
}

async function fetchDexPair(fetchImpl, timeoutMs) {
  const startedAt = Date.now();
  const response = await fetchImpl(DEXSCREENER_PAIRS_URL, {
    headers: { Accept: "application/json", "User-Agent": "ArgonautWorks/base-network-pulse" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`DEX Screener returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("DEX Screener returned a non-array response");
  const pair = body.filter(stableWethPair)
    .sort((left, right) => Number(right.liquidity.usd) - Number(left.liquidity.usd))[0];
  if (!pair) throw new Error("DEX Screener returned no Base WETH stablecoin pair");
  const pairAddress = String(pair.pairAddress ?? "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(pairAddress)) throw new Error("DEX pair address was invalid");

  return {
    name: "dexscreener",
    price_usd: positiveNumber(pair.priceUsd, "DEX WETH price"),
    latency_ms: Date.now() - startedAt,
    pair: {
      dex: String(pair.dexId ?? "unknown"),
      pair_address: pairAddress,
      base_symbol: "WETH",
      quote_symbol: String(pair.quoteToken.symbol),
      price_usd: String(pair.priceUsd),
      liquidity_usd: optionalNumber(pair.liquidity?.usd),
      volume_24h_usd: optionalNumber(pair.volume?.h24),
      price_change_24h_percent: optionalNumber(pair.priceChange?.h24),
      transactions_24h: {
        buys: optionalNumber(pair.txns?.h24?.buys),
        sells: optionalNumber(pair.txns?.h24?.sells),
      },
      evidence_url: `https://dexscreener.com/base/${pairAddress.toLowerCase()}`,
    },
  };
}

export async function fetchMarketPulse({
  fetchImpl = fetch,
  timeoutMs = 5_000,
  now = () => Date.now(),
} = {}) {
  const [coinbaseResult, dexResult] = await Promise.allSettled([
    fetchCoinbase(fetchImpl, timeoutMs),
    fetchDexPair(fetchImpl, timeoutMs),
  ]);
  const coinbase = coinbaseResult.status === "fulfilled" ? coinbaseResult.value : null;
  const dex = dexResult.status === "fulfilled" ? dexResult.value : null;
  if (!coinbase && !dex) throw new Error("ETH market sources are unavailable");
  const premiumBps = coinbase && dex
    ? ((dex.price_usd / coinbase.price_usd) - 1) * 10_000
    : null;

  return {
    status: coinbase && dex ? "healthy" : "degraded",
    observed_at: new Date(now()).toISOString(),
    eth_usd: {
      coinbase_spot: coinbase ? String(coinbase.price_usd) : null,
      base_dex: dex?.pair.price_usd ?? null,
      base_dex_premium_bps: premiumBps == null ? null : Number(premiumBps.toFixed(2)),
    },
    deepest_weth_stable_pool: dex?.pair ?? null,
    sources: [
      { name: "coinbase", status: coinbase ? "available" : "unavailable", latency_ms: coinbase?.latency_ms ?? null },
      { name: "dexscreener", status: dex ? "available" : "unavailable", latency_ms: dex?.latency_ms ?? null },
    ],
  };
}

export function createMarketLoader({
  fetchPulse = fetchMarketPulse,
  ttlMs = 10_000,
  staleTtlMs = 60_000,
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let cachedAt = 0;
  let pending = null;

  return async function loadMarketPulse() {
    const age = now() - cachedAt;
    if (cached && age <= ttlMs) return { ...cached, cache: { age_ms: age, stale: false } };
    if (!pending) {
      pending = Promise.resolve(fetchPulse()).then((pulse) => {
        cached = pulse;
        cachedAt = now();
        return pulse;
      }).finally(() => {
        pending = null;
      });
    }
    try {
      const pulse = await pending;
      return { ...pulse, cache: { age_ms: 0, stale: false } };
    } catch (error) {
      const staleAge = now() - cachedAt;
      if (cached && staleAge <= staleTtlMs) {
        return { ...cached, status: "degraded", cache: { age_ms: staleAge, stale: true } };
      }
      throw error;
    }
  };
}

export const loadMarketPulse = createMarketLoader();
