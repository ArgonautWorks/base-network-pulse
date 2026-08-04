export const DEFAULT_RPC_ENDPOINTS = Object.freeze([
  { name: "base-official", url: "https://mainnet.base.org" },
  { name: "publicnode", url: "https://base-rpc.publicnode.com" },
]);

const RPC_BATCH = Object.freeze([
  { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
  { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
  { jsonrpc: "2.0", id: 3, method: "eth_gasPrice", params: [] },
  { jsonrpc: "2.0", id: 4, method: "eth_maxPriorityFeePerGas", params: [] },
  { jsonrpc: "2.0", id: 5, method: "eth_feeHistory", params: ["0x5", "latest", [10, 50, 90]] },
]);

function asBigInt(value, field) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`${field} was not a hexadecimal quantity`);
  }
  return BigInt(value);
}

function formatUnits(value, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = String(value % base).padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function rpcResult(rows, id) {
  const row = rows.find((candidate) => candidate?.id === id);
  if (!row || row.error || row.result == null) {
    throw new Error(`RPC result ${id} was unavailable`);
  }
  return row.result;
}

async function fetchRpcEndpoint(endpoint, fetchImpl, timeoutMs) {
  const startedAt = Date.now();
  const response = await fetchImpl(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "ArgonautWorks/base-network-pulse" },
    body: JSON.stringify(RPC_BATCH),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${endpoint.name} returned HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error(`${endpoint.name} returned a non-batch response`);

  const chainId = asBigInt(rpcResult(rows, 1), "chain id");
  const blockNumber = asBigInt(rpcResult(rows, 2), "block number");
  const gasPrice = asBigInt(rpcResult(rows, 3), "gas price");
  const priorityFee = asBigInt(rpcResult(rows, 4), "priority fee");
  const feeHistory = rpcResult(rows, 5);
  const baseFees = (feeHistory.baseFeePerGas ?? []).map((value) => asBigInt(value, "base fee"));
  const rewards = (feeHistory.reward ?? []).map((row) => row.map((value) => asBigInt(value, "priority reward")));
  if (baseFees.length < 2 || rewards.length < 1) throw new Error(`${endpoint.name} returned incomplete fee history`);

  return {
    name: endpoint.name,
    chain_id: Number(chainId),
    block_number: Number(blockNumber),
    gas_price_wei: gasPrice,
    priority_fee_wei: priorityFee,
    current_base_fee_wei: baseFees.at(-2),
    next_base_fee_wei: baseFees.at(-1),
    gas_used_ratio: (feeHistory.gasUsedRatio ?? []).map(Number),
    latest_rewards_wei: rewards.at(-1),
    latency_ms: Date.now() - startedAt,
  };
}

function publicSource(source) {
  return {
    name: source.name,
    block_number: source.block_number,
    latency_ms: source.latency_ms,
  };
}

export async function fetchBasePulse({
  endpoints = DEFAULT_RPC_ENDPOINTS,
  fetchImpl = fetch,
  timeoutMs = 5_000,
  now = () => Date.now(),
} = {}) {
  const settled = await Promise.allSettled(
    endpoints.map((endpoint) => fetchRpcEndpoint(endpoint, fetchImpl, timeoutMs)),
  );
  const responsive = settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((source) => source.chain_id === 8453)
    .sort((left, right) => right.block_number - left.block_number || left.latency_ms - right.latency_ms);
  if (!responsive.length) throw new Error("Base RPC sources are unavailable");

  const canonical = responsive[0];
  const blocks = responsive.map((source) => source.block_number);
  const blockSpread = Math.max(...blocks) - Math.min(...blocks);
  const fullyResponsive = responsive.length === endpoints.length;
  const healthy = fullyResponsive && blockSpread <= 2;
  const rewards = canonical.latest_rewards_wei;

  return {
    network: "base-mainnet",
    chain_id: 8453,
    observed_at: new Date(now()).toISOString(),
    status: healthy ? "healthy" : "degraded",
    consensus: {
      responsive_sources: responsive.length,
      configured_sources: endpoints.length,
      block_spread: blockSpread,
      sources: responsive.map(publicSource),
    },
    block: {
      number: canonical.block_number,
    },
    fees: {
      gas_price_gwei: formatUnits(canonical.gas_price_wei, 9),
      priority_fee_gwei: formatUnits(canonical.priority_fee_wei, 9),
      current_base_fee_gwei: formatUnits(canonical.current_base_fee_wei, 9),
      next_base_fee_gwei: formatUnits(canonical.next_base_fee_wei, 9),
      latest_priority_reward_gwei: {
        p10: formatUnits(rewards[0] ?? 0n, 9),
        p50: formatUnits(rewards[1] ?? 0n, 9),
        p90: formatUnits(rewards[2] ?? 0n, 9),
      },
      recent_gas_used_ratio: canonical.gas_used_ratio,
      simple_transfer_cost_eth: formatUnits(canonical.gas_price_wei * 21_000n, 18),
    },
  };
}

export function createPulseLoader({
  fetchPulse = fetchBasePulse,
  ttlMs = 2_000,
  staleTtlMs = 15_000,
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let cachedAt = 0;
  let pending = null;

  return async function loadPulse() {
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

export const loadBasePulse = createPulseLoader();
