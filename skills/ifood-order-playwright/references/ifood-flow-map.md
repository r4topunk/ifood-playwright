# iFood Flow Map (API-first + Playwright)

Use this map to minimize tool calls and token usage.

## 1) Session and entry

- Use persistent session id: `ifood-sim`.
- Open once with: `open https://www.ifood.com.br --headed --persistent`.
- Reuse session with `goto` on next runs.

## 2) Primary path (API-first)

Project script:
- `/Users/r4to/Script/ifood-playwright/scripts/ifood-api-session.mjs`

Recommended commands:
```bash
cd /Users/r4to/Script/ifood-playwright
node scripts/ifood-api-session.mjs health-check --toon
node scripts/ifood-api-session.mjs resolve-item --merchant-term "<loja>" --item-term "<item>" --toon
node scripts/ifood-api-session.mjs add-item --merchant-term "<loja>" --item-term "<item>" --toon
```

What it does:
- Validates session context and API probe (`health-check`)
- Resolves merchant and item via API (`search`, `catalog`, `item details`)
- Applies required subitems when needed
- Executes one UI pass to add and validate cart (`add-item`)
- Uses merchant fallback when best match is unavailable or fails

## 3) Address setup (UI fallback)

Command:
```bash
cd /Users/r4to/Script/ifood-playwright
node scripts/ifood-api-session.mjs ensure-address --address "R. Jorge Rudge, 44 - Vila Isabel, Rio de Janeiro/RJ" --toon
```

Patterns:
- Home input: `textbox "Endereço de entrega e número"`.
- Home button: `button "Buscar"`.
- Restaurants header: `button "Escolha um endereço"`.
- Modal opener: `button "Buscar endereço e número"`.
- Confirm/save: `button "Salvar endereço"`.

## 4) Checkout readiness (safe stop)

Command:
```bash
cd /Users/r4to/Script/ifood-playwright
node scripts/ifood-api-session.mjs checkout-readiness --toon
```

Validation:
- Opens cart if present
- Opens payment selector and attempts Pix selection
- Confirms `Fazer pedido` visibility/enabled state
- Stops before clicking final order button

## 5) Known blockers and handling

- Anti-bot challenge (Cloudflare `Press & Hold`): request manual intervention and retry.
- Store closed (`Fechado` or `Loja fechada`): rely on merchant fallback in `resolve-item`/`add-item`.
- API schema drift: fallback to UI refs and continue flow.
- Missing address: `health-check` returns partial and `ensure-address` should run before order flows.

## 6) Minimal command skeleton

```bash
# API-first full flow
cd /Users/r4to/Script/ifood-playwright
node scripts/ifood-api-session.mjs health-check --toon
node scripts/ifood-api-session.mjs add-item --merchant-term "<loja>" --item-term "<item>" --toon
node scripts/ifood-api-session.mjs checkout-readiness --toon

# UI fallback refs
npx --yes @playwright/cli -s=ifood-sim snapshot
~/.codex/skills/ifood-order-playwright/scripts/ifood_ref_map.sh .playwright-cli/page-YYYY-MM-DDTHH-MM-SS.yml
```
