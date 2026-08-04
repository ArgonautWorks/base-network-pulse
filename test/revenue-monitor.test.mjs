import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_USDC,
  TRANSFER_TOPIC,
  classifyBasePulseTransfer,
  ledgerDate,
  revenueLedgerRow,
} from "../lib/revenue-monitor.mjs";

const WALLET = "0x5e2023b1d1366d6366e768fe432ad627bfaa5d57";
const PAYER = "0x1111111111111111111111111111111111111111";

function addressTopic(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function paidLog(overrides = {}) {
  return {
    address: BASE_USDC,
    topics: [TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(WALLET)],
    data: "0x2328",
    blockNumber: "0x2f3be51",
    transactionHash: "0xabc123",
    ...overrides,
  };
}

const paidTransaction = {
  to: BASE_USDC,
  input: "0xe3ee160e00000000",
};

test("classifies a confirmed external 9,000-atomic-unit EIP-3009 transfer", () => {
  assert.deepEqual(classifyBasePulseTransfer(paidLog(), paidTransaction, WALLET), {
    transaction: "0xabc123",
    payer: PAYER,
    amount_usdc_atomic: "9000",
    block_number: 49528401,
  });
});

test("rejects self-payments, other amounts, and ordinary transfers", () => {
  assert.equal(classifyBasePulseTransfer(
    paidLog({ topics: [TRANSFER_TOPIC, addressTopic(WALLET), addressTopic(WALLET)] }),
    paidTransaction,
    WALLET,
  ), null);
  assert.equal(classifyBasePulseTransfer(paidLog({ data: "0x2710" }), paidTransaction, WALLET), null);
  assert.equal(classifyBasePulseTransfer(paidLog(), { ...paidTransaction, input: "0xa9059cbb" }, WALLET), null);
});

test("formats exact sub-cent realized revenue without rounding", () => {
  const receipt = classifyBasePulseTransfer(paidLog(), paidTransaction, WALLET);
  const date = new Date("2026-08-04T22:30:00.000Z");
  assert.equal(ledgerDate(date), "2026-08-05");
  assert.equal(
    revenueLedgerRow(receipt, date),
    "2026-08-05,E044,api_revenue,0.00,0.009,0.009,Settled external x402 Base network pulse; Base transaction 0xabc123; payer 0x1111111111111111111111111111111111111111",
  );
});
