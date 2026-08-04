import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../app.mjs";

const SAMPLE = {
  network: "base-mainnet",
  chain_id: 8453,
  status: "healthy",
  consensus: { responsive_sources: 2, configured_sources: 2, block_spread: 0, sources: [] },
  block: { number: 49_000_000 },
  fees: { gas_price_gwei: "0.006" },
};

async function withServer(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("publishes free discovery and a sub-cent paid pulse route", async () => {
  await withServer(createApp({ loadPulse: async () => SAMPLE }), async (origin) => {
    const [root, health, openapi, manifest] = await Promise.all([
      fetch(origin).then((response) => response.json()),
      fetch(`${origin}/health`).then((response) => response.json()),
      fetch(`${origin}/openapi.json`).then((response) => response.json()),
      fetch(`${origin}/.well-known/x402`).then((response) => response.json()),
    ]);
    assert.equal(root.price, "$0.009");
    assert.equal(health.version, "0.1.0");
    assert.equal(openapi.paths["/api/v1/pulse"].get.operationId, "getBaseNetworkPulse");
    assert.equal(manifest.resources.length, 2);

    const response = await fetch(`${origin}/api/v1/pulse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 402);
    const challenge = JSON.parse(Buffer.from(response.headers.get("payment-required"), "base64").toString("utf8"));
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.accepts[0].amount, "9000");
  });
});

test("returns an uncharged 503 before payment when every RPC source fails", async () => {
  await withServer(createApp({ loadPulse: async () => { throw new Error("offline"); } }), async (origin) => {
    const response = await fetch(`${origin}/api/v1/pulse`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("payment-required"), null);
    assert.deepEqual(await response.json(), { error: "base_rpc_unavailable", charged: false });
  });
});
