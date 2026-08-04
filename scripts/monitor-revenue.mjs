import fs from "node:fs";
import path from "node:path";
import {
  BASE_USDC,
  TRANSFER_TOPIC,
  classifyBasePulseTransfer,
  revenueLedgerRow,
} from "../lib/revenue-monitor.mjs";

const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const WALLET_FILE = process.env.BASE_PULSE_WALLET_FILE
  ?? "/home/oak/.local/state/venture-lab/frantic-wallet.json";
const STATE_FILE = process.env.BASE_PULSE_REVENUE_STATE
  ?? "/home/oak/.local/state/venture-lab/base-pulse-revenue.json";
const LEDGER_FILE = process.env.BASE_PULSE_LEDGER
  ?? "/home/oak/argonaut-ventures/venture-lab-frantic-monitor/ledger.csv";
const CONFIRMATIONS = 20;
const INITIAL_LOOKBACK_BLOCKS = 2_000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function writeState(value) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, STATE_FILE);
  fs.chmodSync(STATE_FILE, 0o600);
}

async function rpc(method, params) {
  const response = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Base RPC returned ${response.status}`);
  const value = await response.json();
  if (value.error) throw new Error(`Base RPC error ${value.error.code}: ${value.error.message}`);
  return value.result;
}

function hexBlock(value) {
  return `0x${value.toString(16)}`;
}

async function main() {
  const wallet = readJson(WALLET_FILE);
  const receivingWallet = String(wallet?.address ?? "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(receivingWallet)) throw new Error("invalid receiving wallet");

  const prior = readJson(STATE_FILE) ?? { receipts: [] };
  const currentBlock = Number.parseInt(await rpc("eth_blockNumber", []), 16);
  const confirmedBlock = currentBlock - CONFIRMATIONS;
  const fromBlock = Number.isInteger(prior.last_scanned_block)
    ? prior.last_scanned_block + 1
    : Math.max(0, confirmedBlock - INITIAL_LOOKBACK_BLOCKS);
  if (fromBlock > confirmedBlock) {
    console.log("No newly confirmed Base blocks");
    return;
  }

  const paddedWallet = `0x${receivingWallet.slice(2).toLowerCase().padStart(64, "0")}`;
  const logs = await rpc("eth_getLogs", [{
    address: BASE_USDC,
    fromBlock: hexBlock(fromBlock),
    toBlock: hexBlock(confirmedBlock),
    topics: [TRANSFER_TOPIC, null, paddedWallet],
  }]);
  const priorTransactions = new Set((prior.receipts ?? []).map((receipt) => receipt.transaction));
  const ledger = fs.readFileSync(LEDGER_FILE, "utf8");
  const receipts = [];

  for (const log of logs) {
    if (priorTransactions.has(log.transactionHash) || ledger.includes(log.transactionHash)) continue;
    const transaction = await rpc("eth_getTransactionByHash", [log.transactionHash]);
    const receipt = classifyBasePulseTransfer(log, transaction, receivingWallet);
    if (!receipt) continue;
    fs.appendFileSync(LEDGER_FILE, `${revenueLedgerRow(receipt)}\n`, "utf8");
    receipts.push({ ...receipt, recorded_at: new Date().toISOString() });
  }

  const allReceipts = [...(prior.receipts ?? []), ...receipts];
  writeState({
    schema_version: 1,
    updated_at: new Date().toISOString(),
    last_scanned_block: confirmedBlock,
    confirmations: CONFIRMATIONS,
    receipts: allReceipts,
    realized_revenue_usd: allReceipts.length * 0.009,
  });
  console.log(`Scanned ${logs.length} incoming USDC transfer(s); recorded ${receipts.length} paid API call(s)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
