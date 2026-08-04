import express from "express";
import { randomUUID } from "node:crypto";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { loadFullPulse } from "./lib/full-pulse.mjs";

const PAY_TO = process.env.PAY_TO ?? "0x5e2023b1D1366d6366E768fe432AD627bfAa5d57";
const NETWORK = process.env.X402_NETWORK ?? "eip155:8453";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "https://facilitator.payai.network";
const PRICE = process.env.X402_PRICE ?? "$0.009";
const PUBLIC_SOURCE = "https://github.com/ArgonautWorks/base-network-pulse";
const SERVICE_VERSION = "0.3.0";
const SERVICE_DESCRIPTION = "Current Base mainnet block consensus, EIP-1559 fees, ETH/USD reference price, and deepest WETH-stablecoin DEX pool telemetry.";

if (!/^0x[a-fA-F0-9]{40}$/.test(PAY_TO)) throw new Error("PAY_TO must be an EVM address");

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme());

const outputExample = {
  network: "base-mainnet",
  chain_id: 8453,
  status: "healthy",
  consensus: { responsive_sources: 2, configured_sources: 2, block_spread: 0 },
  block: { number: 49_000_000 },
  fees: { gas_price_gwei: "0.006", priority_fee_gwei: "0.001" },
  market: {
    status: "healthy",
    eth_usd: { coinbase_spot: "1869.16", base_dex: "1868.86", base_dex_premium_bps: -1.61 },
    deepest_weth_stable_pool: { dex: "aerodrome", liquidity_usd: 9_500_000, volume_24h_usd: 44_000_000 },
  },
};
const discovery = declareDiscoveryExtension({
  input: {},
  inputSchema: { properties: {}, additionalProperties: false },
  output: { example: outputExample },
});
const postDiscovery = declareDiscoveryExtension({
  input: {},
  inputSchema: { properties: {}, additionalProperties: false },
  bodyType: "json",
  output: { example: outputExample },
});

const paidResource = {
  accepts: [{ scheme: "exact", price: PRICE, network: NETWORK, payTo: PAY_TO }],
  description: SERVICE_DESCRIPTION,
  mimeType: "application/json",
  serviceName: "ArgonautWorks Base Network Pulse",
  tags: ["base", "gas", "block", "rpc", "eth-price", "dex", "market-telemetry"],
  extensions: discovery,
};

export function createRetriableInitializer(initialize, { maxAttempts = 3, retryDelayMs = 100 } = {}) {
  let initialized = false;
  let inFlight = null;

  return async function ensureInitialized() {
    if (initialized) return;
    if (!inFlight) {
      inFlight = (async () => {
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            await initialize();
            initialized = true;
            return;
          } catch (error) {
            lastError = error;
            if (attempt < maxAttempts && retryDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
            }
          }
        }
        throw lastError;
      })();
    }

    try {
      await inFlight;
    } finally {
      if (!initialized) inFlight = null;
    }
  };
}

export function createApp({
  loadPulse = loadFullPulse,
  initializeFacilitator = () => resourceServer.initialize(),
  facilitatorInitOptions,
} = {}) {
  const app = express();
  const ensureFacilitatorInitialized = createRetriableInitializer(
    initializeFacilitator,
    facilitatorInitOptions,
  );
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2kb" }));

  app.use("/api/v1/pulse", async (request, response, next) => {
    if (!["GET", "POST"].includes(request.method)) return next();
    try {
      await ensureFacilitatorInitialized();
    } catch {
      response.set("Retry-After", "1");
      return response.status(502).json({ error: "payment_facilitator_unavailable", charged: false });
    }
    try {
      request.basePulse = await loadPulse();
      return next();
    } catch {
      return response.status(503).json({ error: "base_rpc_unavailable", charged: false });
    }
  });

  app.use(paymentMiddleware({
    "GET /api/v1/pulse": paidResource,
    "POST /api/v1/pulse": { ...paidResource, extensions: postDiscovery },
  }, resourceServer, undefined, undefined, false));

  app.get("/", (_request, response) => {
    response.json({
      service: "ArgonautWorks Base Network Pulse",
      purpose: SERVICE_DESCRIPTION,
      endpoint: "GET or POST /api/v1/pulse",
      price: PRICE,
      settlement: { protocol: "x402", network: NETWORK, asset: "USDC" },
      health: "/health",
      openapi: "/openapi.json",
      agent_card: "/.well-known/agent-card.json",
      a2a: "/a2a",
      x402_manifest: "/.well-known/x402",
      source: PUBLIC_SOURCE,
    });
  });

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "base-network-pulse",
      version: SERVICE_VERSION,
      network: NETWORK,
      facilitator: new URL(FACILITATOR_URL).hostname,
    });
  });

  app.get(["/.well-known/agent.json", "/.well-known/agent-card.json"], (request, response) => {
    const origin = `${request.protocol}://${request.get("host")}`;
    const a2aUrl = `${origin}/a2a`;
    response.json({
      protocolVersion: "0.3",
      name: "ArgonautWorks Base Network Pulse",
      description: SERVICE_DESCRIPTION,
      url: a2aUrl,
      preferredTransport: "JSONRPC",
      additionalInterfaces: [{ url: a2aUrl, transport: "JSONRPC" }],
      version: SERVICE_VERSION,
      provider: { organization: "ArgonautWorks", url: PUBLIC_SOURCE },
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      documentationUrl: `${origin}/openapi.json`,
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain", "application/json"],
      skills: [{
        id: "base-network-pulse",
        name: "Buy Base network pulse",
        description: "Discover how to buy a current Base mainnet, fee, and market telemetry pulse through x402.",
        tags: ["base", "network", "gas", "market-data", "x402"],
        examples: ["How can I buy current Base network telemetry?"],
      }],
    });
  });

  app.post("/a2a", (request, response) => {
    const body = request.body;
    const requestId = body?.id ?? null;
    if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || !["message/send", "SendMessage"].includes(body.method)) {
      response.status(200).json({
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: body?.method ? -32601 : -32600,
          message: body?.method ? "Method not found" : "Invalid Request",
        },
      });
      return;
    }

    const origin = `${request.protocol}://${request.get("host")}`;
    const incoming = body.params?.message;
    const contextId = typeof incoming?.contextId === "string" ? incoming.contextId : randomUUID();
    const taskId = typeof incoming?.taskId === "string" ? incoming.taskId : randomUUID();
    response.json({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        contextId,
        history: [],
        id: taskId,
        kind: "task",
        status: {
          state: "completed",
          timestamp: new Date().toISOString(),
          message: {
            kind: "message",
            messageId: randomUUID(),
            role: "agent",
            parts: [{
              kind: "text",
              text: [
                "ArgonautWorks Base Network Pulse is a paid current Base mainnet telemetry API.",
                `Buy it by calling GET or POST ${origin}/api/v1/pulse and handling its x402 payment challenge.`,
                `The price is ${PRICE} USDC on Base; read ${origin}/openapi.json and ${origin}/.well-known/x402 for the exact contract.`,
              ].join(" "),
            }],
          },
        },
      },
    });
  });

  app.get("/openapi.json", (request, response) => {
    const origin = `${request.protocol}://${request.get("host")}`;
    const operation = (operationId) => ({
      operationId,
      summary: "Get a current Base network, fee, ETH price, and DEX pulse",
      "x-payment-info": {
        price: { mode: "fixed", currency: "USD", amount: "0.009" },
        protocols: [{ x402: {} }],
      },
      responses: {
        200: { description: "Base network pulse" },
        402: { description: "x402 Base-USDC payment challenge" },
        502: { description: "Payment facilitator temporarily unavailable; no payment challenge issued" },
        503: { description: "All upstream RPC sources unavailable; no payment challenge issued" },
      },
    });
    response.json({
      openapi: "3.1.0",
      info: {
        title: "ArgonautWorks Base Network Pulse API",
        version: SERVICE_VERSION,
        description: SERVICE_DESCRIPTION,
        license: { name: "MIT", identifier: "MIT" },
        contact: { name: "ArgonautWorks", url: PUBLIC_SOURCE },
      },
      servers: [{ url: origin }],
      paths: {
        "/api/v1/pulse": {
          get: operation("getBaseNetworkPulse"),
          post: {
            ...operation("getBaseNetworkPulseFromJson"),
            requestBody: {
              required: false,
              content: { "application/json": { schema: { type: "object", additionalProperties: false } } },
            },
          },
        },
        "/a2a": {
          post: {
            operationId: "sendBaseNetworkPulseDiscoveryA2aMessage",
            summary: "Return completed A2A discovery guidance for the paid pulse",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["jsonrpc", "method"],
                    properties: {
                      jsonrpc: { type: "string", const: "2.0" },
                      id: { type: ["string", "number", "null"] },
                      method: { type: "string", enum: ["message/send", "SendMessage"] },
                      params: { type: "object" },
                    },
                  },
                },
              },
            },
            responses: {
              200: { description: "A completed A2A task with purchase discovery guidance; this route is free and does not make a payment or fetch telemetry." },
            },
          },
        },
      },
    });
  });

  app.get("/.well-known/x402", (request, response) => {
    const origin = `${request.protocol}://${request.get("host")}`;
    response.json({
      x402Version: 2,
      serviceName: "ArgonautWorks Base Network Pulse",
      description: SERVICE_DESCRIPTION,
      source: PUBLIC_SOURCE,
      resources: ["GET", "POST"].map((method) => ({
        resource: `${origin}/api/v1/pulse`,
        method,
        price: PRICE,
        network: NETWORK,
        asset: "USDC",
        input: method === "POST" ? { body: {} } : { queryParams: {} },
      })),
    });
  });

  app.get("/llms.txt", (_request, response) => {
    response.type("text/plain").send([
      "# ArgonautWorks Base Network Pulse",
      "",
      SERVICE_DESCRIPTION,
      "",
      "Paid endpoint: GET or POST /api/v1/pulse",
      `Price: ${PRICE} USDC on Base via x402 v2`,
      "Output: block consensus, RPC responsiveness, gas and base fees, ETH/USD cross-source price, deepest Base WETH-stablecoin pool liquidity, volume, activity, and spread.",
      "Upstream failure returns 503 before a payment challenge.",
      "OpenAPI: /openapi.json",
      "A2A agent card: /.well-known/agent-card.json (legacy alias: /.well-known/agent.json)",
      "A2A JSON-RPC endpoint: POST /a2a (purchase discovery only; it does not fetch telemetry or settle payments)",
      "x402 manifest: /.well-known/x402",
      `Source: ${PUBLIC_SOURCE}`,
      "",
    ].join("\n"));
  });

  app.all("/api/v1/pulse", (request, response) => response.json(request.basePulse));
  app.use((_request, response) => response.status(404).json({ error: "not_found" }));
  return app;
}

export default createApp();
