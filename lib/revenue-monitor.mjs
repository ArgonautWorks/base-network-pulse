export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = "0xe3ee160e";
export const PULSE_PRICE_ATOMIC = 9_000n;
export const PULSE_RELAY_PRICE_ATOMIC = 10_000n;
export const PAYAN_AGENT_ID = "j57862sty4g48j03c1vmar1kw98bvsc3";
export const PAYAN_OFFER_ID = "kh70xt1w9y755zse4ersz2xfkh8bvkqr";

function topicAddress(topic) {
  const value = String(topic ?? "").toLowerCase();
  return value.length === 66 ? `0x${value.slice(-40)}` : null;
}

export function qualifyingPayanRelayReceipt(receipt) {
  if (receipt?.offerId !== PAYAN_OFFER_ID || receipt?.sellerId !== PAYAN_AGENT_ID) return false;
  if (receipt?.buyerId === PAYAN_AGENT_ID || receipt?.status !== "confirmed" || receipt?.delivered !== true) return false;
  if (receipt?.settlementType !== "direct" || receipt?.network !== "eip155:8453") return false;
  const microUsd = Number(receipt?.amountMicroUsd ?? Number(receipt?.amountCents) * 10_000);
  return microUsd === 10_000 && /^0x[a-fA-F0-9]{64}$/.test(String(receipt?.txHash ?? ""));
}

export function classifyBasePulseTransfer(
  log,
  transaction,
  receivingWallet,
  { verifiedPayanTransactions = new Set() } = {},
) {
  const wallet = String(receivingWallet).toLowerCase();
  if (String(log?.address).toLowerCase() !== BASE_USDC.toLowerCase()) return null;
  if (String(log?.topics?.[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
  const from = topicAddress(log?.topics?.[1]);
  const to = topicAddress(log?.topics?.[2]);
  if (!from || !to || to !== wallet || from === wallet) return null;

  let amount;
  try {
    amount = BigInt(log.data);
  } catch {
    return null;
  }
  const transactionHash = String(log.transactionHash);
  const channel = amount === PULSE_PRICE_ATOMIC
    ? "direct"
    : amount === PULSE_RELAY_PRICE_ATOMIC
      && verifiedPayanTransactions.has(transactionHash.toLowerCase())
      ? "payanagent"
      : null;
  if (!channel) return null;
  if (String(transaction?.to).toLowerCase() !== BASE_USDC.toLowerCase()) return null;
  if (!String(transaction?.input ?? "").toLowerCase().startsWith(TRANSFER_WITH_AUTHORIZATION_SELECTOR)) {
    return null;
  }

  return {
    channel,
    revenue_usd: channel === "direct" ? 0.009 : 0.01,
    transaction: transactionHash,
    payer: from,
    amount_usdc_atomic: amount.toString(),
    block_number: Number.parseInt(log.blockNumber, 16),
  };
}

export function ledgerDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function revenueLedgerRow(receipt, date = new Date()) {
  const revenue = receipt.channel === "direct" ? "0.009" : "0.01";
  const note = `Settled external x402 Base network pulse via ${receipt.channel}; Base transaction ${receipt.transaction}; payer ${receipt.payer}`;
  return [ledgerDate(date), "E044", "api_revenue", "0.00", revenue, revenue, note]
    .map(csvCell)
    .join(",");
}
