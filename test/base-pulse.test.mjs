import assert from "node:assert/strict";
import test from "node:test";
import { createPulseLoader, fetchBasePulse } from "../lib/base-pulse.mjs";

function rpcRows(block = "0x2f3f3a1") {
  return [
    { jsonrpc: "2.0", id: 1, result: "0x2105" },
    { jsonrpc: "2.0", id: 2, result: block },
    { jsonrpc: "2.0", id: 3, result: "0x5b8d80" },
    { jsonrpc: "2.0", id: 4, result: "0xf4240" },
    { jsonrpc: "2.0", id: 5, result: {
      baseFeePerGas: ["0x4c4b40", "0x4c4b40", "0x4c4b40", "0x4c4b40", "0x4c4b40", "0x4c4b40"],
      gasUsedRatio: [0.04, 0.05, 0.03, 0.02, 0.06],
      reward: [
        ["0x0", "0xf4240", "0x2191c0"],
        ["0x0", "0xf4240", "0x2191c0"],
        ["0x0", "0xf4240", "0x2191c0"],
        ["0x0", "0xf4240", "0x2191c0"],
        ["0x0", "0xf4240", "0xa21fe8"],
      ],
    } },
  ];
}

test("builds a healthy deterministic pulse from agreeing Base RPC sources", async () => {
  const pulse = await fetchBasePulse({
    endpoints: [{ name: "one", url: "https://one" }, { name: "two", url: "https://two" }],
    fetchImpl: async () => ({ ok: true, json: async () => rpcRows() }),
    now: () => Date.parse("2026-08-04T20:00:00Z"),
  });
  assert.equal(pulse.status, "healthy");
  assert.equal(pulse.chain_id, 8453);
  assert.equal(pulse.consensus.responsive_sources, 2);
  assert.equal(pulse.consensus.block_spread, 0);
  assert.equal(pulse.fees.gas_price_gwei, "0.006");
  assert.equal(pulse.fees.priority_fee_gwei, "0.001");
  assert.equal(pulse.fees.current_base_fee_gwei, "0.005");
  assert.equal(pulse.fees.latest_priority_reward_gwei.p90, "0.010625");
  assert.equal(pulse.fees.simple_transfer_cost_eth, "0.000000126");
});

test("degrades gracefully when one configured source is unavailable", async () => {
  const pulse = await fetchBasePulse({
    endpoints: [{ name: "one", url: "https://one" }, { name: "two", url: "https://two" }],
    fetchImpl: async (url) => {
      if (url.endsWith("two")) throw new Error("offline");
      return { ok: true, json: async () => rpcRows() };
    },
  });
  assert.equal(pulse.status, "degraded");
  assert.equal(pulse.consensus.responsive_sources, 1);
});

test("serves a short stale cache when a refresh fails", async () => {
  let clock = 1_000;
  let calls = 0;
  const loader = createPulseLoader({
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
