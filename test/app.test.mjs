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

test("publishes free discovery, A2A purchase guidance, and a sub-cent paid pulse route", async () => {
  await withServer(createApp({ loadPulse: async () => SAMPLE }), async (origin) => {
    const [root, health, openapi, manifest, card, legacyCard, llms] = await Promise.all([
      fetch(origin).then((response) => response.json()),
      fetch(`${origin}/health`).then((response) => response.json()),
      fetch(`${origin}/openapi.json`).then((response) => response.json()),
      fetch(`${origin}/.well-known/x402`).then((response) => response.json()),
      fetch(`${origin}/.well-known/agent-card.json`).then((response) => response.json()),
      fetch(`${origin}/.well-known/agent.json`).then((response) => response.json()),
      fetch(`${origin}/llms.txt`).then((response) => response.text()),
    ]);
    assert.equal(root.price, "$0.009");
    assert.equal(root.a2a, "/a2a");
    assert.equal(health.version, "0.3.0");
    assert.equal(openapi.paths["/api/v1/pulse"].get.operationId, "getBaseNetworkPulse");
    assert.equal(openapi.paths["/a2a"].post.operationId, "sendBaseNetworkPulseDiscoveryA2aMessage");
    assert.equal(manifest.resources.length, 2);
    assert.equal(card.protocolVersion, "0.3");
    assert.equal(card.url, `${origin}/a2a`);
    assert.equal(card.skills[0].id, "base-network-pulse");
    assert.deepEqual(legacyCard, card);
    assert.match(llms, /A2A JSON-RPC endpoint: POST \/a2a/);

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

test("returns completed A2A purchase discovery without fetching telemetry, initializing payment, or reflecting the request", async () => {
  let pulseLoads = 0;
  let facilitatorInitializations = 0;
  await withServer(createApp({
    loadPulse: async () => { pulseLoads += 1; return SAMPLE; },
    initializeFacilitator: async () => { facilitatorInitializations += 1; },
  }), async (origin) => {
    const response = await fetch(`${origin}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request-9",
        method: "message/send",
        params: { message: { contextId: "context-9", taskId: "task-9", parts: [{ kind: "text", text: "secret input must not be copied" }] } },
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("payment-required"), null);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, "request-9");
    assert.equal(body.result.kind, "task");
    assert.equal(body.result.id, "task-9");
    assert.equal(body.result.contextId, "context-9");
    assert.equal(body.result.status.state, "completed");
    assert.equal(body.result.history.length, 0);
    assert.match(body.result.status.message.parts[0].text, new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/api/v1/pulse`));
    assert.match(body.result.status.message.parts[0].text, /\$0\.009 USDC on Base/);
    assert.doesNotMatch(JSON.stringify(body), /secret input must not be copied/);
    assert.equal(pulseLoads, 0);
    assert.equal(facilitatorInitializations, 0);

    const legacy = await fetch(`${origin}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "SendMessage" }),
    }).then((item) => item.json());
    assert.equal(legacy.result.status.state, "completed");

    const invalid = await fetch(`${origin}/a2a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tasks/get" }),
    }).then((item) => item.json());
    assert.deepEqual(invalid, {
      jsonrpc: "2.0",
      id: 11,
      error: { code: -32601, message: "Method not found" },
    });
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

test("retries facilitator initialization and fails without charging", async () => {
  let attempts = 0;
  const app = createApp({
    loadPulse: async () => SAMPLE,
    initializeFacilitator: async () => {
      attempts += 1;
      throw new Error("facilitator offline");
    },
    facilitatorInitOptions: { maxAttempts: 3, retryDelayMs: 0 },
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/v1/pulse`);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("payment-required"), null);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.deepEqual(await response.json(), { error: "payment_facilitator_unavailable", charged: false });
    assert.equal(attempts, 3);
  });
});
