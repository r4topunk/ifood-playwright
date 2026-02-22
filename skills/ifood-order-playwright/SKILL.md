---
name: "ifood-order-playwright"
description: "Automate iFood order simulation with API-first discovery and Playwright fallback using a persistent browser session. Use when the user asks to search restaurants/items, inspect menu/options, add items to cart, configure checkout, or stop before 'Fazer pedido'."
---

# iFood Order Playwright

Prefer API-first discovery (merchant/item/options) and use Playwright only for final UI actions that still require browser context.

## Quick start

1. Start or reuse persistent session:
```bash
~/.codex/skills/ifood-order-playwright/scripts/ifood_session.sh ifood-sim https://www.ifood.com.br
```

2. Validate session and environment early:
```bash
cd /Users/r4to/Script/ifood-playwright
node scripts/ifood-api-session.mjs health-check --toon
```

3. Resolve and add item (API-first + minimal UI):
```bash
cd /Users/r4to/Script/ifood-playwright
node scripts/ifood-api-session.mjs add-item --merchant-term "blue ribbon" --item-term "smash bacon duplo" --toon
```

4. Prepare checkout (safe stop before final order):
```bash
cd /Users/r4to/Script/ifood-playwright
node scripts/ifood-api-session.mjs checkout-readiness --toon
```

## Agent-friendly output

Use `--toon` (or `--agent`) whenever output will be consumed by another agent.

Stable schema:
- `ok`
- `stage`
- `errorCode`
- `message`
- `details`
- `warnings`
- `performance`

## Stable flow map

Read `references/ifood-flow-map.md` before interacting with iFood pages.

## Guardrails

- Keep a single persistent session id (`ifood-sim`) unless the user asks otherwise.
- Stop at `Fazer pedido` unless user explicitly asks to submit real order.
- Prefer API endpoints from `scripts/ifood-api-session.mjs` for search/catalog/item resolution.
- Use Playwright refs/snapshots only when API cannot complete the step.
- If anti-bot challenge appears, ask user to solve manually and then continue.
- Do not persist volatile business data (price, promo, availability) unless user explicitly asks.
