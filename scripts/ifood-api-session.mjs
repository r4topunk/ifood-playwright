#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SESSION = process.env.IFOOD_SESSION || "ifood-sim";
const OUTPUT_DIR = join(process.cwd(), "output");
const SAVE_TO_FILE = process.argv.includes("--save");
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

function fail(msg) {
  console.error(msg);
  process.exit(1);
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
    fail(`Falha no playwright-cli:\n${detail}`);
  }
  return out.stdout;
}

function parseResult(stdout) {
  const marker = "### Result";
  const idx = stdout.indexOf(marker);
  if (idx < 0) fail(`Não consegui ler saída do playwright-cli:\n${stdout}`);
  const after = stdout.slice(idx + marker.length).trimStart();
  const nextMarker = after.indexOf("\n### ");
  const raw = (nextMarker >= 0 ? after.slice(0, nextMarker) : after).trim();
  try {
    return JSON.parse(raw);
  } catch {
    fail(`JSON inválido no retorno:\n${raw}`);
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

function emit(prefix, data, summary = null) {
  const payload = withMetrics(data);
  const file = maybeSaveJson(prefix, payload);
  if (file) {
    console.log(`${prefix} salvo em: ${file}`);
  } else {
    console.log(JSON.stringify(redactSensitive(payload), null, 2));
  }
  if (summary) console.log(summary);
}

function getArg(flag, required = true) {
  const idx = process.argv.indexOf(flag);
  const value = idx >= 0 ? process.argv[idx + 1] : undefined;
  if (required && (!value || value.startsWith("--"))) {
    fail(`Parâmetro obrigatório ausente: ${flag}`);
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
      "  node scripts/ifood-api-session.mjs context",
      "  node scripts/ifood-api-session.mjs search-merchants --term \"blue ribbon\" [--lat -22.9130192 --lon -43.2381099]",
      "  node scripts/ifood-api-session.mjs catalog --merchant-id <uuid> [--lat -22.9130192 --lon -43.2381099]",
      "  node scripts/ifood-api-session.mjs item --merchant-id <uuid> --item-id <uuid>",
      "  node scripts/ifood-api-session.mjs resolve-item --merchant-term \"blue ribbon\" --item-term \"smash bacon duplo\"",
      "  node scripts/ifood-api-session.mjs add-item --merchant-term \"blue ribbon\" --item-term \"smash bacon duplo\"",
      "  node scripts/ifood-api-session.mjs capture-carts [--merchant-id <uuid>] [--item-id <uuid>]",
      "  (opcional) adicione --save para gravar em output/",
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

function pickMerchant(merchants, query) {
  const ranked = merchants
    .map((m) => ({
      ...m,
      score: scoreMatch(query, m.name) + (m.available ? 15 : 0)
    }))
    .sort((a, b) => b.score - a.score);
  return ranked[0] || null;
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

  let merchant = null;
  if (args.merchantId) {
    merchant = { id: args.merchantId, name: args.merchantTerm || "(id direto)", slug: args.merchantSlug || null };
  } else {
    if (!args.merchantTerm) fail("Informe --merchant-term ou --merchant-id");
    const searchRes = await searchMerchants(ctx, args.merchantTerm, lat, lon);
    if (!searchRes.ok) fail(`Falha no search-merchants: HTTP ${searchRes.status}`);
    const merchants = parseMerchantCandidates(searchRes.response);
    const picked = pickMerchant(merchants, args.merchantTerm);
    if (!picked) fail(`Nenhum merchant encontrado para: ${args.merchantTerm}`);
    merchant = picked;
  }

  let item = null;
  if (args.itemId) {
    const detailRes = await getItemDetails(ctx, merchant.id, args.itemId);
    if (!detailRes.ok) fail(`Falha no item details: HTTP ${detailRes.status}`);
    const parsed = parseItemDetails(detailRes.response);
    if (!parsed) fail("Item não encontrado no payload de detalhes");
    item = parsed;
  } else {
    if (!args.itemTerm) fail("Informe --item-term ou --item-id");
    const catalogRes = await getCatalog(ctx, merchant.id, lat, lon);
    if (!catalogRes.ok) fail(`Falha no catalog: HTTP ${catalogRes.status}`);
    const items = parseCatalogItems(catalogRes.response);
    const pickedItem = pickItem(items, args.itemTerm);
    if (!pickedItem) fail(`Nenhum item encontrado para: ${args.itemTerm}`);

    const detailRes = await getItemDetails(ctx, merchant.id, pickedItem.id);
    if (!detailRes.ok) fail(`Falha no item details: HTTP ${detailRes.status}`);
    const parsed = parseItemDetails(detailRes.response);
    if (!parsed) fail("Item encontrado no catálogo, mas não retornou em details");
    item = parsed;
  }

  return {
    merchant: {
      id: merchant.id,
      name: merchant.name,
      slug: merchant.slug || null,
      available: merchant.available ?? true
    },
    item,
    coords: { lat, lon }
  };
}

async function uiAddItem(plan) {
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
    if (!loaded) throw new Error('Não consegui abrir página do item');

    await page.waitForTimeout(1500);

    for (const sub of plan.item.subItems || []) {
      try {
        const locator = page.getByText(sub.description, { exact: false }).first();
        if (await locator.isVisible({ timeout: 1200 })) {
          await locator.click({ timeout: 2000 });
        }
      } catch {}
    }

    const addBtn = page.locator('[data-test-id="dish-action__add-button"]');
    await addBtn.click({ timeout: 8000 });
    await page.waitForTimeout(1200);

    const shuffleBtn = page.locator('[data-test-id="cart-shuffle-accept-button"]');
    if (await shuffleBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await shuffleBtn.click({ timeout: 3000 });
      await page.waitForTimeout(1200);
    }

    const cartText = page.locator('text=' + itemName).first();
    const itemAppears = await cartText.isVisible({ timeout: 3000 }).catch(() => false);

    return {
      ok: itemAppears,
      loadedUrl: loaded,
      currentUrl: page.url(),
      itemName,
      message: itemAppears ? 'Item visível no carrinho/painel.' : 'Item não confirmado visualmente; valide no carrinho.'
    };
  }`);
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

  const ctx = getSessionContext();
  if (!ctx.accessToken) fail("Sessão sem aAccessToken. Refaça login no iFood.");

  if (command === "context") {
    const redacted = {
      ...ctx,
      accessToken: `${ctx.accessToken.slice(0, 24)}...`,
      px3: ctx.px3 ? `${ctx.px3.slice(0, 16)}...` : null
    };
    emit("context", redacted);
    return;
  }

  if (command === "search-merchants") {
    const term = getArg("--term");
    const lat = getArg("--lat", false) ?? DEFAULT_LAT;
    const lon = getArg("--lon", false) ?? DEFAULT_LON;
    const result = await searchMerchants(ctx, term, lat, lon);
    emit("search-merchants", result, `status: ${result.status}`);
    return;
  }

  if (command === "catalog") {
    const merchantId = getArg("--merchant-id");
    const lat = getArg("--lat", false) ?? DEFAULT_LAT;
    const lon = getArg("--lon", false) ?? DEFAULT_LON;
    const result = await getCatalog(ctx, merchantId, lat, lon);
    emit("catalog", result, `status: ${result.status}`);
    return;
  }

  if (command === "item") {
    const merchantId = getArg("--merchant-id");
    const itemId = getArg("--item-id");
    const result = await getItemDetails(ctx, merchantId, itemId);
    emit("item", result, `status: ${result.status}`);
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
    emit("resolve-item", { ok: true, plan }, "resolve-item concluído");
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
      emit("add-item", { ok: true, mode: "dry-run", plan }, "dry-run: nada foi adicionado");
      return;
    }

    const ui = await uiAddItem(plan);
    emit("add-item", { ok: ui.ok, mode: "execute", plan, ui }, ui.message);
    return;
  }

  if (command === "capture-carts") {
    const merchantId =
      getArg("--merchant-id", false) ??
      "621d98e9-cd75-44d4-8124-1dbbb3f2a750";
    const itemId =
      getArg("--item-id", false) ?? "b04b11cd-3275-42b9-8a4f-660985a06806";

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

    emit("capture-carts", payload, `hits capturados: ${payload.hits?.length ?? 0}`);
    return;
  }

  usage();
  process.exit(1);
}

main().catch((err) => fail(`Erro: ${err?.stack || err}`));
