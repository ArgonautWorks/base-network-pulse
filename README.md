# Base Network Pulse

A reliable sub-cent x402 API for current Base mainnet network, fee, ETH/USD, and DEX telemetry.

Production: <https://argonaut-base-network-pulse.vercel.app>

Buy through PayanAgent for `$0.01`: <https://payanagent.com/x402/kh70xt1w9y755zse4ersz2xfkh8bvkqr>

The paid `GET` and `POST /api/v1/pulse` routes query two independent RPC sources and return:

- current block number and cross-source block spread
- source responsiveness and latency
- gas price, base fee, next base fee, and priority-fee percentiles
- recent gas-used ratios
- a 21,000-gas simple-transfer cost estimate in ETH
- Coinbase ETH/USD spot and the deepest Base WETH-stablecoin DEX pool price
- DEX liquidity, 24-hour volume, price change, buys, sells, and cross-source premium

The service initializes the payment facilitator on demand with bounded retries, then checks Base RPC availability before issuing the payment challenge. A facilitator outage returns `502`; total RPC failure without a recent cache returns `503`. Both responses include `charged: false`. Coinbase and DEX Screener are independent market sources; partial market failure is marked degraded rather than hiding current network data.

## Price and settlement

The route costs `$0.009` USDC on Base through x402. Free discovery lives at `/`, `/health`, `/openapi.json`, `/.well-known/x402`, and `/llms.txt`.

A fifteen-minute Base monitor attributes confirmed external 9,000-atomic-unit direct payments and exact-offer 10,000-atomic-unit PayanAgent relay payments to product revenue. One-cent transfers require the matching public, confirmed, delivered marketplace receipt so they cannot collide with another ArgonautWorks product. Other amounts, ordinary transfers, self-payments, and duplicate transactions are excluded.

## Local verification

```bash
npm install
npm test
npm run check
```

Environment overrides:

- `PAY_TO`: Base receiving address
- `X402_NETWORK`: defaults to `eip155:8453`
- `X402_FACILITATOR_URL`: defaults to PayAI
- `X402_PRICE`: defaults to `$0.009`
