#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SESSION = process.env.IFOOD_SESSION || "ifood-sim";
const OUTPUT_DIR = join(process.cwd(), "output");
const SAVE_TO_FILE = process.argv.includes("--save");
const TOON_MODE = process.argv.includes("--toon") || process.argv.includes("--agent");
const METRICS = { apiCalls: 0, playwrightCalls: 0, startedAt: Date.now() };

const DEFAULT_LAT = "-22.9130192";
const DEFAULT_LON = "-43.2381099";

const SEARCH_PAYLOAD = {
  "supported-headers": ["OPERATION_HEADER"],
  "supported-cards": [
    "MERCHANT_LIST",
    "CATALOG_ITEM_LIST",
    "CATALOG_ITEM_LIST_V2",
    "CATALOG_ITEM_LIST_V3",
    "FEATURED_MERCHANT_LIST",
    "CATALOG_ITEM_CAROUSEL",
    "CATALOG_ITEM_CAROUSEL_V2",
    "CATALOG_ITEM_CAROUSEL_V3",
    "BIG_BANNER_CAROUSEL",
    "IMAGE_BANNER",
    "MERCHANT_LIST_WITH_ITEMS_CAROUSEL",
    "SMALL_BANNER_CAROUSEL",
    "NEXT_CONTENT",
    "MERCHANT_CAROUSEL",
    "MERCHANT_TILE_CAROUSEL",
    "SIMPLE_MERCHANT_CAROUSEL",
    "INFO_CARD",
    "MERCHANT_LIST_V2",
    "ROUND_IMAGE_CAROUSEL",
    "BANNER_GRID",
    "MEDIUM_IMAGE_BANNER",
    "MEDIUM_BANNER_CAROUSEL",
    "RELATED_SEARCH_CAROUSEL",
    "ADS_BANNER"
  ],
  "supported-actions": [
    "catalog-item",
    "item-details",
    "merchant",
    "page",
    "card-content",
    "last-restaurants",
    "webmiddleware",
    "reorder",
    "search",
    "groceries",
    "home-tab"
  ],
  "feed-feature-name": "",
  "faster-overrides": ""
};

class ScriptError extends Error {
  constructor(message, code = "SCRIPT_ERROR", stage = "unknown", details = null) {
    super(message);
    this.name = "ScriptError";
    this.code = code;
    this.stage = stage;
    this.details = details;
  }
}

function throwError(message, code = "SCRIPT_ERROR", stage = "unknown", details = null) {
  throw new ScriptError(message, code, stage, details);
}

function nowMs() {
  return Date.now();
}

function elapsedMs(start) {
  return nowMs() - start;
}

function withMetrics(data) {
  return {
    ...data,
    performance: {
      apiCalls: METRICS.apiCalls,
      playwrightCalls: METRICS.playwrightCalls,
      elapsedMs: elapsedMs(METRICS.startedAt)
    }
  };
}

function runPlaywrightCli(args) {
  METRICS.playwrightCalls += 1;
  const cmdArgs = ["--yes", "@playwright/cli", `-s=${SESSION}`, ...args];
  const out = spawnSync("npx", cmdArgs, { encoding: "utf8" });
  if (out.status !== 0) {
    const detail = [out.stdout, out.stderr].filter(Boolean).join("\n");
    throwError(`Falha no playwright-cli`, "PLAYWRIGHT_CLI_FAILED", "playwright", { detail });
  }
  return out.stdout;
}

function parseResult(stdout) {
  const marker = "### Result";
  const idx = stdout.indexOf(marker);
  if (idx < 0) throwError("Não consegui ler saída do playwright-cli", "PARSE_RESULT_FAILED", "playwright", { stdout });
  const after = stdout.slice(idx + marker.length).trimStart();
  const nextMarker = after.indexOf("\n### ");
  const raw = (nextMarker >= 0 ? after.slice(0, nextMarker) : after).trim();
  try {
    return JSON.parse(raw);
  } catch {
    throwError("JSON inválido no retorno", "INVALID_JSON_RESULT", "playwright", { raw });
  }
}

function pwEvalJson(fnSource) {
  return parseResult(runPlaywrightCli(["run-code", fnSource]));
}

function maybeSaveJson(prefix, data) {
  if (!SAVE_TO_FILE) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(OUTPUT_DIR, `${prefix}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function redactSensitive(input) {
  const SENSITIVE_KEYS = new Set([
    "authorization",
    "x-px-cookies",
    "cookie",
    "set-cookie",
    "access_token",
    "aaccesstoken",
    "refresh_token",
    "arefreshtoken",
    "secret_key",
    "access_key"
  ]);

  if (Array.isArray(input)) return input.map((v) => redactSensitive(v));
  if (!input || typeof input !== "object") return input;

  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const normalized = k.toLowerCase();
    if (SENSITIVE_KEYS.has(normalized)) {
      out[k] = typeof v === "string" && v.length > 12 ? `${v.slice(0, 6)}...` : "***";
    } else {
      out[k] = redactSensitive(v);
    }
  }
  return out;
}

function toon(payload) {
  return {
    ok: Boolean(payload.ok),
    stage: payload.stage || "unknown",
    errorCode: payload.errorCode || null,
    message: payload.message || null,
    details: payload.details || {},
    warnings: payload.warnings || [],
    performance: payload.performance
  };
}

function emit(prefix, data) {
  const enriched = withMetrics({
    command: prefix,
    ...data
  });
  const redacted = redactSensitive(enriched);
  const payload = TOON_MODE ? toon(redacted) : redacted;
  const file = maybeSaveJson(prefix, payload);
  if (file) {
    console.log(JSON.stringify({ ok: true, stage: "io", message: `${prefix} salvo em: ${file}` }, null, 2));
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function getArg(flag, required = true) {
  const idx = process.argv.indexOf(flag);
  const value = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (required && (!value || value.startsWith("--"))) {
    throwError(`Parâmetro obrigatório ausente: ${flag}`, "MISSING_ARG", "args", { flag });
  }
  return value;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function usage() {
  console.log(
    [
      "Uso:",
      "  node scripts/ifood-api-session.mjs health-check [--with-api] [--with-ui]",
      "  node scripts/ifood-api-session.mjs ensure-address [--address \"R. X, 10\"]",
      "  node scripts/ifood-api-session.mjs checkout-readiness",
      "  node scripts/ifood-api-session.mjs context",
      "  node scripts/ifood-api-session.mjs search-merchants --term \"blue ribbon\" [--lat -22.9130192 --lon -43.2381099]",
      "  node scripts/ifood-api-session.mjs catalog --merchant-id <uuid> [--lat -22.9130192 --lon -43.2381099]",
      "  node scripts/ifood-api-session.mjs item --merchant-id <uuid> --item-id <uuid>",
      "  node scripts/ifood-api-session.mjs resolve-item --merchant-term \"blue ribbon\" --item-term \"smash bacon duplo\"",
      "  node scripts/ifood-api-session.mjs add-item --merchant-term \"blue ribbon\" --item-term \"smash bacon duplo\"",
      "  node scripts/ifood-api-session.mjs capture-carts [--merchant-id <uuid>] [--item-id <uuid>]",
      "",
      "Flags globais:",
      "  --save   grava o JSON em output/",
      "  --toon   saída compacta para agentes (schema estável)",
      "  --agent  alias de --toon",
      "",
      "Dica:",
      "  export IFOOD_SESSION=ifood-sim",
      ""
    ].join("\n")
  );
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMatch(query, candidate) {
  const q = normalizeText(query);
  const c = normalizeText(candidate);
  if (!q || !c) return 0;
  if (q === c) return 200;
  let score = 0;
  if (c.includes(q)) score += 120;
  const tokens = q.split(" ").filter(Boolean);
  for (const token of tokens) {
    if (c.includes(token)) score += 20;
  }
  if (c.startsWith(tokens[0] || "")) score += 10;
  return score;
}

function getSessionContext() {
  return pwEvalJson(`async (page) => {
    const cookies = await page.context().cookies();
    const pick = (name) => cookies.find((c) => c.name === name)?.value || null;
    return {
      accessToken: pick("aAccessToken"),
      accountId: pick("aAccountId"),
      appVersion: pick("aAppVersion"),
      appKey: pick("aFasterAppKey"),
      deviceId: pick("aDeviceId"),
      sessionId: pick("aSessionId"),
      px3: pick("_px3"),
      pxvid: pick("_pxvid"),
      pxcts: pick("pxcts")
    };
  }`);
}

function validateSessionContext(ctx) {
  const requiredKeys = [
    "accessToken",
    "accountId",
    "appVersion",
    "appKey",
    "deviceId",
    "sessionId",
    "px3",
    "pxvid",
    "pxcts"
  ];
  const missing = requiredKeys.filter((key) => !ctx[key]);
  return {
    ok: missing.length === 0,
    missing,
    checks: {
      accessTokenLength: ctx.accessToken ? ctx.accessToken.length : 0,
      accountIdPresent: Boolean(ctx.accountId)
    }
  };
}

function commonHeaders(ctx) {
  return {
    Authorization: `Bearer ${ctx.accessToken}`,
    browser: "Mac OS",
    "x-device-model": "Macintosh Chrome",
    "X-Ifood-Session-Id": ctx.sessionId,
    platform: "Desktop",
    "x-client-application-key": ctx.appKey,
    "X-Ifood-Device-Id": ctx.deviceId,
    "Cache-Control": "no-cache, no-store",
    "accept-language": "pt-BR,pt;q=1",
    account_id: ctx.accountId,
    app_version: ctx.appVersion,
    "x-px-cookies": `_px3=${ctx.px3}; _pxvid=${ctx.pxvid}; pxcts=${ctx.pxcts}, true`,
    "x-ifood-user-id": ctx.accountId
  };
}

async function apiRequest(method, url, headers, body = null) {
  METRICS.apiCalls += 1;
  const init = { method, headers };
  if (body !== null) {
    init.body = JSON.stringify(body);
    init.headers = { ...headers, "Content-Type": "application/json" };
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return {
    status: res.status,
    ok: res.ok,
    url,
    headers,
    body,
    response: json ?? text
  };
}

async function searchMerchants(ctx, term, lat = DEFAULT_LAT, lon = DEFAULT_LON) {
  const termEncoded = encodeURIComponent(term).replace(/%20/g, "+");
  const url =
    "https://cw-marketplace.ifood.com.br/v2/cardstack/search/results" +
    `?alias=SEARCH_RESULTS_MERCHANT_TAB_GLOBAL&latitude=${lat}&longitude=${lon}` +
    `&channel=IFOOD&size=20&term=${termEncoded}`;

  const headers = {
    ...commonHeaders(ctx),
    experiment_variant: "default_merchant",
    Country: "BR",
    test_merchants: "undefined",
    experiment_details:
      '{ "default_merchant": { "model_id": "search-rerank-endpoint", "recommendation_filter": "AVAILABLE_FOR_SCHEDULING_FIXED", "available_for_scheduling_recommended_limit": 5, "engine": "sagemaker", "backend_experiment_id": "v4", "query_rewriter_rule": "merchant-names", "second_search": true, "force_similar_search_disabled": true, "similar_search": { "open_merchants_threshold": 5, "max_similar_merchants": 5 } } }'
  };

  return apiRequest("POST", url, headers, SEARCH_PAYLOAD);
}

function parseMerchantCandidates(searchResponse) {
  const cards = (searchResponse?.sections || []).flatMap((s) => s?.cards || []);
  const out = [];
  for (const card of cards) {
    if (card?.cardType !== "MERCHANT_LIST_V2") continue;
    const contents = card?.data?.contents || [];
    for (const m of contents) {
      const action = String(m?.action || "");
      const q = action.includes("?") ? action.split("?")[1] : "";
      const params = new URLSearchParams(q);
      out.push({
        id: m?.id,
        name: m?.name,
        available: Boolean(m?.available),
        action,
        slug: params.get("slug") || null,
        score: 0
      });
    }
  }
  return out.filter((m) => m.id && m.name);
}

function rankMerchants(merchants, query) {
  return merchants
    .map((m) => ({
      ...m,
      score: scoreMatch(query, m.name) + (m.available ? 25 : -100)
    }))
    .sort((a, b) => b.score - a.score);
}

async function getCatalog(ctx, merchantId, lat = DEFAULT_LAT, lon = DEFAULT_LON) {
  const url = `https://cw-marketplace.ifood.com.br/v1/merchants/restaurant/${merchantId}/catalog?latitude=${lat}&longitude=${lon}`;
  return apiRequest("GET", url, commonHeaders(ctx));
}

function parseCatalogItems(catalogResponse) {
  const menu = catalogResponse?.data?.menu || [];
  const items = [];
  for (const section of menu) {
    for (const item of section?.itens || []) {
      items.push({
        id: item?.id,
        description: item?.description,
        details: item?.details,
        needChoices: item?.needChoices,
        unitPrice: item?.unitPrice,
        section: section?.name || null
      });
    }
  }
  return items.filter((i) => i.id && i.description);
}

function pickItem(items, query) {
  const ranked = items
    .map((i) => ({
      ...i,
      score: scoreMatch(query, `${i.description} ${i.details || ""}`)
    }))
    .sort((a, b) => b.score - a.score);
  return ranked[0] || null;
}

async function getItemDetails(ctx, merchantId, itemId) {
  const url = `https://cw-marketplace.ifood.com.br/v1/merchants/restaurant/${merchantId}/items/${itemId}`;
  return apiRequest("GET", url, commonHeaders(ctx));
}

function parseItemDetails(itemResponse) {
  const item = itemResponse?.data?.menu?.[0]?.itens?.[0] || null;
  if (!item) return null;
  const requiredChoices = [];
  for (const choice of item?.choices || []) {
    const min = Number(choice?.min || 0);
    if (min <= 0) continue;
    const garnish = Array.isArray(choice?.garnishItens) ? choice.garnishItens : [];
    const selected = garnish.slice(0, min).map((g) => ({
      id: g?.id,
      description: g?.description,
      unitPrice: g?.unitPrice
    }));
    requiredChoices.push({
      code: choice?.code,
      name: choice?.name,
      min,
      selected
    });
  }
  return {
    id: item?.id,
    description: item?.description,
    details: item?.details,
    needChoices: item?.needChoices,
    unitPrice: item?.unitPrice,
    requiredChoices,
    subItems: requiredChoices.flatMap((c) => c.selected.map((s) => ({ id: s.id, description: s.description })))
  };
}

async function resolveItemPlan(ctx, args) {
  const lat = args.lat || DEFAULT_LAT;
  const lon = args.lon || DEFAULT_LON;
  const attempts = [];

  if (args.merchantId) {
    const merchant = { id: args.merchantId, name: args.merchantTerm || "(id direto)", slug: args.merchantSlug || null, available: true };
    const item = await resolveItemForMerchant(ctx, merchant, args, lat, lon, attempts);
    return {
      merchant,
      item,
      attempts,
      coords: { lat, lon }
    };
  }

  if (!args.merchantTerm) {
    throwError("Informe --merchant-term ou --merchant-id", "MISSING_MERCHANT", "resolve-item");
  }

  const searchRes = await searchMerchants(ctx, args.merchantTerm, lat, lon);
  if (!searchRes.ok) {
    throwError(`Falha no search-merchants: HTTP ${searchRes.status}`, "SEARCH_FAILED", "resolve-item", { status: searchRes.status });
  }

  const ranked = rankMerchants(parseMerchantCandidates(searchRes.response), args.merchantTerm);
  if (!ranked.length) {
    throwError(`Nenhum merchant encontrado para: ${args.merchantTerm}`, "MERCHANT_NOT_FOUND", "resolve-item");
  }

  for (const merchant of ranked) {
    try {
      const item = await resolveItemForMerchant(ctx, merchant, args, lat, lon, attempts);
      return {
        merchant: {
          id: merchant.id,
          name: merchant.name,
          slug: merchant.slug || null,
          available: merchant.available
        },
        item,
        attempts,
        coords: { lat, lon }
      };
    } catch (error) {
      attempts.push({
        merchantId: merchant.id,
        merchantName: merchant.name,
        available: merchant.available,
        ok: false,
        reason: error.message
      });
    }
  }

  throwError("Nenhum merchant elegível conseguiu resolver o item", "MERCHANT_FALLBACK_EXHAUSTED", "resolve-item", { attempts });
}

async function resolveItemForMerchant(ctx, merchant, args, lat, lon, attempts) {
  if (args.itemId) {
    const detailRes = await getItemDetails(ctx, merchant.id, args.itemId);
    if (!detailRes.ok) {
      throwError(`Falha no item details: HTTP ${detailRes.status}`, "ITEM_DETAILS_FAILED", "resolve-item", { status: detailRes.status });
    }
    const parsed = parseItemDetails(detailRes.response);
    if (!parsed) {
      throwError("Item não encontrado no payload de detalhes", "ITEM_NOT_IN_DETAILS", "resolve-item");
    }
    attempts.push({
      merchantId: merchant.id,
      merchantName: merchant.name,
      available: merchant.available,
      ok: true,
      reason: "item-id resolvido"
    });
    return parsed;
  }

  if (!args.itemTerm) {
    throwError("Informe --item-term ou --item-id", "MISSING_ITEM", "resolve-item");
  }

  const catalogRes = await getCatalog(ctx, merchant.id, lat, lon);
  if (!catalogRes.ok) {
    throwError(`Falha no catalog: HTTP ${catalogRes.status}`, "CATALOG_FAILED", "resolve-item", { status: catalogRes.status });
  }

  const items = parseCatalogItems(catalogRes.response);
  const pickedItem = pickItem(items, args.itemTerm);
  if (!pickedItem) {
    throwError(`Nenhum item encontrado para: ${args.itemTerm}`, "ITEM_NOT_FOUND", "resolve-item");
  }

  const detailRes = await getItemDetails(ctx, merchant.id, pickedItem.id);
  if (!detailRes.ok) {
    throwError(`Falha no item details: HTTP ${detailRes.status}`, "ITEM_DETAILS_FAILED", "resolve-item", { status: detailRes.status });
  }

  const parsed = parseItemDetails(detailRes.response);
  if (!parsed) {
    throwError("Item encontrado no catálogo, mas não retornou em details", "ITEM_NOT_IN_DETAILS", "resolve-item");
  }

  attempts.push({
    merchantId: merchant.id,
    merchantName: merchant.name,
    available: merchant.available,
    ok: true,
    reason: "item-term resolvido"
  });
  return parsed;
}

function isAntiBot(uiResult) {
  return Boolean(uiResult?.antiBot);
}

async function uiEnsureAddress(addressQuery = null) {
  const escapedAddress = JSON.stringify(addressQuery || "")
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");

  return pwEvalJson(`async (page) => {
    const query = JSON.parse(\`${escapedAddress}\`);
    const antiBotPattern = /(press\s*&\s*hold|verifique que voce e humano|cloudflare)/i;

    const antiBot = async () => {
      const text = await page.locator('body').innerText().catch(() => '');
      return antiBotPattern.test(text || '');
    };

    await page.goto('https://www.ifood.com.br', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1200);

    if (await antiBot()) {
      return { ok: false, antiBot: true, message: 'Challenge anti-bot detectado.' };
    }

    const readAddress = async () => {
      const candidates = [
        page.getByRole('button', { name: /escolha um endereco/i }).first(),
        page.getByRole('button', { name: /buscar endereco e numero/i }).first(),
        page.getByRole('button', { name: /endereco de entrega/i }).first()
      ];
      for (const c of candidates) {
        try {
          if (await c.isVisible({ timeout: 500 })) {
            const txt = await c.innerText().catch(() => null);
            if (txt) return txt.trim();
          }
        } catch {}
      }
      return null;
    };

    const before = await readAddress();

    if (query) {
      const opener = page.getByRole('button', { name: /escolha um endereco|buscar endereco e numero/i }).first();
      if (await opener.isVisible({ timeout: 2500 }).catch(() => false)) {
        await opener.click({ timeout: 3000 }).catch(() => {});
      }

      const input = page.getByRole('textbox', { name: /endereco de entrega e numero|buscar endereco/i }).first();
      if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
        await input.fill(query).catch(() => {});
        await input.press('Enter').catch(() => {});
        await page.waitForTimeout(1500);
      }

      const resultOption = page.getByText(query.split(',')[0], { exact: false }).first();
      if (await resultOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await resultOption.click({ timeout: 3000 }).catch(() => {});
      }

      const saveBtn = page.getByRole('button', { name: /salvar endereco/i }).first();
      if (await saveBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
        await saveBtn.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }
    }

    const after = await readAddress();
    const hasAddress = Boolean(after && !/escolha um endereco|buscar endereco e numero/i.test(after));
    const matchesQuery = query ? (after || '').toLowerCase().includes(query.split(',')[0].toLowerCase()) : null;

    return {
      ok: hasAddress && (query ? Boolean(matchesQuery) : true),
      antiBot: false,
      before,
      after,
      hasAddress,
      matchesQuery,
      currentUrl: page.url()
    };
  }`);
}

async function uiAddAndValidateCart(plan) {
  const escapedPlan = JSON.stringify(plan)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");

  return pwEvalJson(`async (page) => {
    const plan = JSON.parse(\`${escapedPlan}\`);
    const merchantId = plan.merchant.id;
    const itemId = plan.item.id;
    const slug = plan.merchant.slug;
    const itemName = plan.item.description || "";

    const antiBotPattern = /(press\s*&\s*hold|verifique que voce e humano|cloudflare)/i;
    const antiBot = async () => {
      const text = await page.locator('body').innerText().catch(() => '');
      return antiBotPattern.test(text || '');
    };

    const candidates = [];
    if (slug) candidates.push('https://www.ifood.com.br/delivery/' + slug + '/' + merchantId + '?prato=' + itemId);
    candidates.push('https://www.ifood.com.br/delivery/rio-de-janeiro-rj/' + merchantId + '?prato=' + itemId);

    let loaded = null;
    for (const url of candidates) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        loaded = url;
        break;
      } catch {}
    }
    if (!loaded) {
      return { ok: false, errorCode: 'ITEM_PAGE_UNAVAILABLE', antiBot: false, message: 'Não consegui abrir página do item.' };
    }

    await page.waitForTimeout(1500);

    if (await antiBot()) {
      return { ok: false, antiBot: true, errorCode: 'ANTI_BOT_CHALLENGE', message: 'Challenge anti-bot detectado.' };
    }

    for (const sub of plan.item.subItems || []) {
      try {
        const locator = page.getByText(sub.description, { exact: false }).first();
        if (await locator.isVisible({ timeout: 1200 })) {
          await locator.click({ timeout: 2000 });
        }
      } catch {}
    }

    const addBtn = page.locator('[data-test-id="dish-action__add-button"]');
    if (!await addBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
      return { ok: false, antiBot: false, errorCode: 'ADD_BUTTON_NOT_FOUND', message: 'Botão de adicionar não encontrado.' };
    }

    await addBtn.click({ timeout: 8000 });
    await page.waitForTimeout(1200);

    const shuffleBtn = page.locator('[data-test-id="cart-shuffle-accept-button"]');
    if (await shuffleBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await shuffleBtn.click({ timeout: 3000 });
      await page.waitForTimeout(1200);
    }

    const openCartBtn = page.locator('[data-test-id="header-cart"]').first();
    if (await openCartBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await openCartBtn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }

    const itemVisible = await page.getByText(itemName, { exact: false }).first().isVisible({ timeout: 3500 }).catch(() => false);
    const quantityVisible = await page.getByText('1x', { exact: false }).first().isVisible({ timeout: 1000 }).catch(() => false);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const moneyMatches = (bodyText.match(/R\$\s?\d+[\.,]\d{2}/g) || []).slice(0, 5);

    return {
      ok: itemVisible,
      antiBot: false,
      loadedUrl: loaded,
      currentUrl: page.url(),
      itemName,
      message: itemVisible ? 'Item adicionado e visível no carrinho.' : 'Item não confirmado no carrinho.',
      cart: {
        itemVisible,
        quantityVisible,
        currencyHints: moneyMatches
      }
    };
  }`);
}

async function uiCheckoutReadiness() {
  return pwEvalJson(`async (page) => {
    const antiBotPattern = /(press\s*&\s*hold|verifique que voce e humano|cloudflare)/i;
    const antiBot = async () => {
      const text = await page.locator('body').innerText().catch(() => '');
      return antiBotPattern.test(text || '');
    };

    if (await antiBot()) {
      return { ok: false, antiBot: true, errorCode: 'ANTI_BOT_CHALLENGE', message: 'Challenge anti-bot detectado.' };
    }

    const cartBtn = page.locator('[data-test-id="header-cart"]').first();
    if (await cartBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
      await cartBtn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }

    const paymentSelect = page.locator('[data-test-id="payment-info-select-method-button"]').first();
    const paymentOpen = await paymentSelect.isVisible({ timeout: 2500 }).catch(() => false);
    if (paymentOpen) {
      await paymentSelect.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    const pix = page.getByText('Pix', { exact: false }).first();
    const pixVisible = await pix.isVisible({ timeout: 2500 }).catch(() => false);
    if (pixVisible) {
      await pix.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
    }

    const orderBtn = page.getByRole('button', { name: /fazer pedido/i }).first();
    const orderVisible = await orderBtn.isVisible({ timeout: 3500 }).catch(() => false);
    const orderEnabled = orderVisible ? await orderBtn.isEnabled().catch(() => false) : false;

    return {
      ok: orderVisible && orderEnabled,
      antiBot: false,
      paymentSelectorVisible: paymentOpen,
      pixVisible,
      orderButtonVisible: orderVisible,
      orderButtonEnabled: orderEnabled,
      stopPoint: 'Não clicado em Fazer pedido',
      currentUrl: page.url()
    };
  }`);
}

async function runHealthCheck(ctx, withApi, withUi) {
  const session = validateSessionContext(ctx);
  if (!session.ok) {
    throwError("Sessão incompleta. Refaça login no iFood.", "SESSION_INCOMPLETE", "health-check", { missing: session.missing });
  }

  let api = null;
  if (withApi) {
    const probe = await searchMerchants(ctx, "pizza", DEFAULT_LAT, DEFAULT_LON);
    api = {
      ok: probe.ok,
      status: probe.status,
      sampleMerchants: parseMerchantCandidates(probe.response).slice(0, 3).map((m) => ({ id: m.id, name: m.name, available: m.available }))
    };
    if (!probe.ok) {
      throwError(`Falha no probe de API: HTTP ${probe.status}`, "API_PROBE_FAILED", "health-check", { status: probe.status });
    }
  }

  let ui = null;
  if (withUi) {
    ui = await uiEnsureAddress(null);
    if (isAntiBot(ui)) {
      throwError("Challenge anti-bot detectado. Resolva manualmente e rode novamente.", "ANTI_BOT_CHALLENGE", "health-check", ui);
    }
  }

  const overallOk =
    session.ok &&
    (!withApi || Boolean(api?.ok)) &&
    (!withUi || Boolean(ui?.ok));
  const warnings = [];
  if (withUi && !ui?.ok) {
    warnings.push("Endereço de entrega não confirmado na UI.");
  }

  return {
    ok: overallOk,
    stage: "health-check",
    errorCode: overallOk ? null : "HEALTH_CHECK_PARTIAL",
    message: overallOk ? "Health-check concluído" : "Health-check com pendências",
    warnings,
    details: {
      session,
      api,
      ui,
      sessionId: SESSION
    }
  };
}

function shouldLoadContext(command) {
  const contextCommands = new Set([
    "context",
    "health-check",
    "search-merchants",
    "catalog",
    "item",
    "resolve-item",
    "add-item"
  ]);
  return contextCommands.has(command);
}

async function main() {
  const command = process.argv[2];
  if (!command) {
    usage();
    process.exit(1);
  }

  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  const ctx = shouldLoadContext(command) ? getSessionContext() : null;

  if (command === "context") {
    const validation = validateSessionContext(ctx);
    const redacted = {
      ...ctx,
      accessToken: ctx.accessToken ? `${ctx.accessToken.slice(0, 24)}...` : null,
      px3: ctx.px3 ? `${ctx.px3.slice(0, 16)}...` : null
    };
    emit("context", {
      ok: validation.ok,
      stage: "context",
      errorCode: validation.ok ? null : "SESSION_INCOMPLETE",
      message: validation.ok ? "Contexto de sessão válido" : "Contexto de sessão incompleto",
      details: { context: redacted, validation }
    });
    return;
  }

  if (shouldLoadContext(command) && !ctx?.accessToken) {
    throwError("Sessão sem aAccessToken. Refaça login no iFood.", "SESSION_MISSING", "bootstrap");
  }

  if (command === "health-check") {
    const result = await runHealthCheck(ctx, hasFlag("--with-api") || !hasFlag("--no-api"), hasFlag("--with-ui") || !hasFlag("--no-ui"));
    emit("health-check", result);
    return;
  }

  if (command === "ensure-address") {
    const address = getArg("--address", false);
    const ui = await uiEnsureAddress(address || null);
    if (isAntiBot(ui)) {
      throwError("Challenge anti-bot detectado. Resolva manualmente e rode novamente.", "ANTI_BOT_CHALLENGE", "ensure-address", ui);
    }
    if (!ui.ok) {
      throwError("Endereço não confirmado", "ADDRESS_NOT_CONFIRMED", "ensure-address", ui);
    }
    emit("ensure-address", {
      ok: true,
      stage: "ensure-address",
      message: "Endereço confirmado",
      details: ui
    });
    return;
  }

  if (command === "search-merchants") {
    const term = getArg("--term");
    const lat = getArg("--lat", false) ?? DEFAULT_LAT;
    const lon = getArg("--lon", false) ?? DEFAULT_LON;
    const result = await searchMerchants(ctx, term, lat, lon);
    emit("search-merchants", {
      ok: result.ok,
      stage: "search-merchants",
      errorCode: result.ok ? null : "SEARCH_FAILED",
      message: `status: ${result.status}`,
      details: result
    });
    return;
  }

  if (command === "catalog") {
    const merchantId = getArg("--merchant-id");
    const lat = getArg("--lat", false) ?? DEFAULT_LAT;
    const lon = getArg("--lon", false) ?? DEFAULT_LON;
    const result = await getCatalog(ctx, merchantId, lat, lon);
    emit("catalog", {
      ok: result.ok,
      stage: "catalog",
      errorCode: result.ok ? null : "CATALOG_FAILED",
      message: `status: ${result.status}`,
      details: result
    });
    return;
  }

  if (command === "item") {
    const merchantId = getArg("--merchant-id");
    const itemId = getArg("--item-id");
    const result = await getItemDetails(ctx, merchantId, itemId);
    emit("item", {
      ok: result.ok,
      stage: "item",
      errorCode: result.ok ? null : "ITEM_DETAILS_FAILED",
      message: `status: ${result.status}`,
      details: result
    });
    return;
  }

  if (command === "resolve-item") {
    const plan = await resolveItemPlan(ctx, {
      merchantTerm: getArg("--merchant-term", false),
      merchantId: getArg("--merchant-id", false),
      merchantSlug: getArg("--merchant-slug", false),
      itemTerm: getArg("--item-term", false),
      itemId: getArg("--item-id", false),
      lat: getArg("--lat", false),
      lon: getArg("--lon", false)
    });
    emit("resolve-item", {
      ok: true,
      stage: "resolve-item",
      message: "resolve-item concluído",
      details: { plan }
    });
    return;
  }

  if (command === "add-item") {
    const dryRun = hasFlag("--dry-run");
    const plan = await resolveItemPlan(ctx, {
      merchantTerm: getArg("--merchant-term", false),
      merchantId: getArg("--merchant-id", false),
      merchantSlug: getArg("--merchant-slug", false),
      itemTerm: getArg("--item-term", false),
      itemId: getArg("--item-id", false),
      lat: getArg("--lat", false),
      lon: getArg("--lon", false)
    });

    if (dryRun) {
      emit("add-item", {
        ok: true,
        stage: "add-item",
        message: "dry-run: nada foi adicionado",
        details: { mode: "dry-run", plan }
      });
      return;
    }

    const ui = await uiAddAndValidateCart(plan);
    if (isAntiBot(ui)) {
      throwError("Challenge anti-bot detectado. Resolva manualmente e rode novamente.", "ANTI_BOT_CHALLENGE", "add-item", ui);
    }
    const ok = Boolean(ui.ok);
    emit("add-item", {
      ok,
      stage: "add-item",
      errorCode: ok ? null : "CART_VALIDATION_FAILED",
      message: ok ? "Item adicionado e carrinho validado" : "Item adicionado, mas validação do carrinho falhou",
      details: {
        mode: "execute",
        plan,
        ui
      }
    });
    return;
  }

  if (command === "checkout-readiness") {
    const ui = await uiCheckoutReadiness();
    if (isAntiBot(ui)) {
      throwError("Challenge anti-bot detectado. Resolva manualmente e rode novamente.", "ANTI_BOT_CHALLENGE", "checkout-readiness", ui);
    }
    emit("checkout-readiness", {
      ok: ui.ok,
      stage: "checkout-readiness",
      errorCode: ui.ok ? null : "CHECKOUT_NOT_READY",
      message: ui.ok ? "Checkout pronto até o ponto seguro" : "Checkout ainda não está pronto",
      details: ui
    });
    return;
  }

  if (command === "capture-carts") {
    const merchantId = getArg("--merchant-id", false) ?? "621d98e9-cd75-44d4-8124-1dbbb3f2a750";
    const itemId = getArg("--item-id", false) ?? "b04b11cd-3275-42b9-8a4f-660985a06806";

    const payload = pwEvalJson(`async (page) => {
      const client = await page.context().newCDPSession(page);
      await client.send("Network.enable");
      const hits = [];
      client.on("Network.requestWillBeSent", (evt) => {
        const url = evt.request?.url || "";
        if (!url.includes("cw-marketplace.ifood.com.br/v1/carts")) return;
        hits.push({
          method: evt.request?.method,
          url,
          headers: evt.request?.headers,
          postData: evt.request?.postData || null
        });
      });

      await page.goto("https://www.ifood.com.br/delivery/rio-de-janeiro-rj/suburbanos-pizza-rustica-rzn3-vila-isabel/${merchantId}?prato=${itemId}");
      await page.waitForTimeout(2500);

      const massa = page.locator("span").filter({ hasText: "Massa Tradicional (Ny Style)" }).locator('[data-test-id="radio-span"]').first();
      if (await massa.isVisible({ timeout: 4000 })) await massa.click();

      const addBtn = page.locator('[data-test-id="dish-action__add-button"]');
      await addBtn.click({ timeout: 5000 });
      await page.waitForTimeout(2500);
      return { hits };
    }`);

    emit("capture-carts", {
      ok: true,
      stage: "capture-carts",
      message: `hits capturados: ${payload.hits?.length ?? 0}`,
      details: payload
    });
    return;
  }

  usage();
  process.exit(1);
}

main().catch((err) => {
  const known = err instanceof ScriptError;
  const payload = {
    ok: false,
    stage: known ? err.stage : "unknown",
    errorCode: known ? err.code : "UNHANDLED_ERROR",
    message: err?.message || String(err),
    details: known ? err.details : { stack: err?.stack || null }
  };
  emit("error", payload);
  process.exit(1);
});
