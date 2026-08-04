# Base Network Pulse

A reliable one-cent x402 API for current Base mainnet block consensus and EIP-1559 fee telemetry.

Production: <https://argonaut-base-network-pulse.vercel.app>

Buy through PayanAgent: <https://payanagent.com/x402/kh70xt1w9y755zse4ersz2xfkh8bvkqr>

The paid `GET` and `POST /api/v1/pulse` routes query two independent RPC sources and return:

- current block number and cross-source block spread
- source responsiveness and latency
- gas price, base fee, next base fee, and priority-fee percentiles
- recent gas-used ratios
- a 21,000-gas simple-transfer cost estimate in ETH

The service checks upstream availability before issuing the payment challenge. If every RPC source is unavailable and there is no recent cache, it returns `503` with `charged: false`.

## Price and settlement

The route costs `$0.01` USDC on Base through x402. Free discovery lives at `/`, `/health`, `/openapi.json`, `/.well-known/x402`, and `/llms.txt`.

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
- `X402_PRICE`: defaults to `$0.01`
