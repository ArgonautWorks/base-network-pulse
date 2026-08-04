import assert from "node:assert/strict";
import test from "node:test";
import { loadFullPulse } from "../lib/full-pulse.mjs";
import { createMarketLoader, fetchMarketPulse } from "../lib/market-pulse.mjs";

const WETH = "0x4200000000000000000000000000000000000006";

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function dexPair({ liquidity = 10_000_000, price = "2001", pair = "0x1111111111111111111111111111111111111111" } = {}) {
  return {
    chainId: "base",
    dexId: "aerodrome",
    pairAddress: pair,
    baseToken: { address: WETH, symbol: "WETH" },
    quoteToken: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC" },
    priceUsd: price,
    liquidity: { usd: liquidity },
    volume: { h24: 4_000_000 },
    priceChange: { h24: -0.25 },
    txns: { h24: { buys: 1200, sells: 1300 } },
  };
}

test("combines Coinbase ETH spot with the deepest Base WETH stablecoin pool", async () => {
  const pulse = await fetchMarketPulse({
    fetchImpl: async (url) => String(url).includes("coinbase")
      ? jsonResponse({ data: { amount: "2000", base: "ETH", currency: "USD" } })
      : jsonResponse([
        dexPair({ liquidity: 2_000_000, price: "1999", pair: "0x2222222222222222222222222222222222222222" }),
        dexPair(),
      ]),
    now: () => Date.parse("2026-08-04T20:30:00Z"),
  });
  assert.equal(pulse.status, "healthy");
  assert.equal(pulse.observed_at, "2026-08-04T20:30:00.000Z");
  assert.equal(pulse.eth_usd.coinbase_spot, "2000");
  assert.equal(pulse.eth_usd.base_dex, "2001");
  assert.equal(pulse.eth_usd.base_dex_premium_bps, 5);
  assert.equal(pulse.deepest_weth_stable_pool.pair_address, "0x1111111111111111111111111111111111111111");
  assert.equal(pulse.deepest_weth_stable_pool.liquidity_usd, 10_000_000);
  assert.deepEqual(pulse.deepest_weth_stable_pool.transactions_24h, { buys: 1200, sells: 1300 });
});

test("marks partial market-source failure degraded and total failure unavailable", async () => {
  const degraded = await fetchMarketPulse({
    fetchImpl: async (url) => String(url).includes("coinbase")
      ? jsonResponse({}, 503)
      : jsonResponse([dexPair()]),
  });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.eth_usd.coinbase_spot, null);
  assert.equal(degraded.eth_usd.base_dex, "2001");

  const combined = await loadFullPulse({
    loadNetwork: async () => ({ network: "base-mainnet", status: "healthy" }),
    loadMarket: async () => { throw new Error("offline"); },
  });
  assert.equal(combined.network, "base-mainnet");
  assert.equal(combined.market.status, "unavailable");

  await assert.rejects(() => fetchMarketPulse({ fetchImpl: async () => jsonResponse({}, 503) }));
  await assert.rejects(() => loadFullPulse({
    loadNetwork: async () => { throw new Error("rpc offline"); },
    loadMarket: async () => ({ status: "healthy" }),
  }), /rpc offline/);
});

test("rejects symbol-spoofed stablecoin pairs", async () => {
  const spoofed = dexPair({ liquidity: 99_000_000 });
  spoofed.quoteToken.address = "0x9999999999999999999999999999999999999999";
  const pulse = await fetchMarketPulse({
    fetchImpl: async (url) => String(url).includes("coinbase")
      ? jsonResponse({ data: { amount: "2000", base: "ETH", currency: "USD" } })
      : jsonResponse([spoofed, dexPair({ liquidity: 1_000_000 })]),
  });
  assert.equal(pulse.deepest_weth_stable_pool.liquidity_usd, 1_000_000);
});

test("serves a bounded stale market snapshot when refresh fails", async () => {
  let clock = 1_000;
  let calls = 0;
  const loader = createMarketLoader({
    now: () => clock,
    ttlMs: 10,
    staleTtlMs: 100,
    fetchPulse: async () => {
      calls += 1;
      if (calls > 1) throw new Error("offline");
      return { status: "healthy", observed_at: "first" };
    },
  });
  assert.equal((await loader()).cache.stale, false);
  clock += 20;
  const stale = await loader();
  assert.equal(stale.status, "degraded");
  assert.equal(stale.cache.stale, true);
  assert.equal(stale.cache.age_ms, 20);
});
