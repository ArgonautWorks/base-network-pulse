import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const statePath = process.env.PAYANAGENT_STATE_FILE
  ?? "/home/oak/.local/state/venture-lab/payanagent.json";
const endpoint = process.env.BASE_PULSE_ENDPOINT
  ?? "https://argonaut-base-network-pulse.vercel.app/api/v1/pulse";
const state = JSON.parse(await readFile(statePath, "utf8"));
if (!state.apiKey) throw new Error("PayanAgent state is missing apiKey");

async function persistState() {
  const temporary = path.join(path.dirname(statePath), `.${path.basename(statePath)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}

const offerPayload = {
  title: "Base Gas + Block Metrics — RPC consensus",
  description: "Reliable live Base mainnet gas and block metrics from two independent RPC sources: block consensus, source latency, gas price, current and next base fee, priority-fee percentiles, recent utilization, and a simple-transfer cost estimate. Upstreams are checked before payment; total failure returns an uncharged 503.",
  category: "Blockchain",
  tags: ["base", "gas", "block-metrics", "rpc-consensus", "live-data"],
  // Keep relay settlements distinct from the existing one-cent product while
  // PayanAgent's live update API rejects its documented sub-cent metadata.
  priceCents: 2,
  offerType: "api",
  endpoint,
  httpMethod: "POST",
  inputSchema: "{}",
  outputSchema: "{network, chain_id, observed_at, status, consensus, block, fees}",
};
const existingOfferId = state.offers?.baseNetworkPulse?.offerId;
if (existingOfferId) {
  const response = await fetch(`https://payanagent.com/api/v1/offers/${existingOfferId}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${state.apiKey}`,
      "content-type": "application/json",
      "user-agent": "ArgonautWorks/base-network-pulse",
    },
    body: JSON.stringify(offerPayload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`PayanAgent offer update failed with HTTP ${response.status}`);
  const body = await response.json();
  const offer = body.offer ?? body;
  state.offers.baseNetworkPulse = {
    ...state.offers.baseNetworkPulse,
    amountRaw: offer.amountRaw ?? "20000",
    network: offer.network ?? "eip155:8453",
  };
  await persistState();
  console.log(JSON.stringify({
    synced: true,
    offer_id: existingOfferId,
    buy_url: state.offers.baseNetworkPulse.buyUrl,
    amount_raw: state.offers.baseNetworkPulse.amountRaw,
  }));
  process.exit(0);
}

const response = await fetch("https://payanagent.com/api/v1/offers", {
  method: "POST",
  headers: {
    authorization: `Bearer ${state.apiKey}`,
    "content-type": "application/json",
    "user-agent": "ArgonautWorks/base-network-pulse",
  },
  body: JSON.stringify(offerPayload),
  signal: AbortSignal.timeout(30_000),
});
const body = await response.json();
if (!response.ok) throw new Error(`PayanAgent offer creation failed with HTTP ${response.status}`);
const offerId = body.offerId ?? body.offer?._id ?? body.offer?.id;
if (!offerId) throw new Error("PayanAgent offer creation omitted offerId");

state.offers ??= {};
state.offers.baseNetworkPulse = {
  offerId,
  buyUrl: body.buyUrl ?? `https://payanagent.com/x402/${offerId}`,
  amountRaw: body.amountRaw ?? "20000",
  network: body.network ?? "eip155:8453",
};
await persistState();

console.log(JSON.stringify({
  offer_id: offerId,
  buy_url: state.offers.baseNetworkPulse.buyUrl,
  amount_raw: state.offers.baseNetworkPulse.amountRaw,
  network: state.offers.baseNetworkPulse.network,
}));
