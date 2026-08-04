export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const TRANSFER_WITH_AUTHORIZATION_SELECTOR = "0xe3ee160e";
export const PULSE_PRICE_ATOMIC = 9_000n;
export const PULSE_RELAY_PRICE_ATOMIC = 20_000n;

function topicAddress(topic) {
  const value = String(topic ?? "").toLowerCase();
  return value.length === 66 ? `0x${value.slice(-40)}` : null;
}

export function classifyBasePulseTransfer(log, transaction, receivingWallet) {
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
  if (amount !== PULSE_PRICE_ATOMIC && amount !== PULSE_RELAY_PRICE_ATOMIC) return null;
  if (String(transaction?.to).toLowerCase() !== BASE_USDC.toLowerCase()) return null;
  if (!String(transaction?.input ?? "").toLowerCase().startsWith(TRANSFER_WITH_AUTHORIZATION_SELECTOR)) {
    return null;
  }

  return {
    channel: amount === PULSE_PRICE_ATOMIC ? "direct" : "payanagent",
    revenue_usd: amount === PULSE_PRICE_ATOMIC ? 0.009 : 0.02,
    transaction: String(log.transactionHash),
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
  const revenue = receipt.channel === "direct" ? "0.009" : "0.02";
  const note = `Settled external x402 Base network pulse via ${receipt.channel}; Base transaction ${receipt.transaction}; payer ${receipt.payer}`;
  return [ledgerDate(date), "E044", "api_revenue", "0.00", revenue, revenue, note]
    .map(csvCell)
    .join(",");
}
