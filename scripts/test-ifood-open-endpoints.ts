#!/usr/bin/env -S node --experimental-strip-types

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

type EndpointEntry = {
  endpoint: string;
  methods: string[];
  statuses: number[];
  pages: string[];
  likelyMutation?: boolean;
};

type SpecJson = {
  generatedAt: string;
  session: string;
  global: {
    endpoints: EndpointEntry[];
  };
};

type SessionContext = {
  accessToken: string | null;
  accountId: string | null;
  appVersion: string | null;
  appKey: string | null;
  deviceId: string | null;
  sessionId: string | null;
  px3: string | null;
  pxvid: string | null;
  pxcts: string | null;
};

const cwd = process.cwd();
const outputDir = join(cwd, 'output');
const specPath = process.argv[2] || join(outputDir, 'ifood-open-api-spec.json');
const session = process.env.IFOOD_SESSION || 'ifood-sim';

function runPlaywrightCli(args: string[]): string {
  const out = spawnSync('npx', ['--yes', '@playwright/cli', `-s=${session}`, ...args], {
    encoding: 'utf8'
  });

  if (out.status !== 0) {
    throw new Error([out.stdout, out.stderr].filter(Boolean).join('\n'));
  }
  return out.stdout;
}

function parseResult(stdout: string): any {
  const marker = '### Result';
  const idx = stdout.indexOf(marker);
  if (idx < 0) throw new Error('Nao consegui parsear retorno do playwright-cli.');

  const after = stdout.slice(idx + marker.length).trimStart();
  const nextMarker = after.indexOf('\n### ');
  const raw = (nextMarker >= 0 ? after.slice(0, nextMarker) : after).trim();
  return JSON.parse(raw);
}

function getSessionContext(): SessionContext {
  const payload = parseResult(
    runPlaywrightCli([
      'run-code',
      `async (page) => {
        const cookies = await page.context().cookies();
        const pick = (name) => cookies.find((c) => c.name === name)?.value || null;
        return {
          accessToken: pick('aAccessToken'),
          accountId: pick('aAccountId'),
          appVersion: pick('aAppVersion'),
          appKey: pick('aFasterAppKey'),
          deviceId: pick('aDeviceId'),
          sessionId: pick('aSessionId'),
          px3: pick('_px3'),
          pxvid: pick('_pxvid'),
          pxcts: pick('pxcts')
        };
      }`
    ])
  );
  return payload as SessionContext;
}

function commonHeaders(ctx: SessionContext): Record<string, string> {
  return {
    Authorization: `Bearer ${ctx.accessToken || ''}`,
    browser: 'Mac OS',
    'x-device-model': 'Macintosh Chrome',
    'X-Ifood-Session-Id': ctx.sessionId || '',
    platform: 'Desktop',
    'x-client-application-key': ctx.appKey || '',
    'X-Ifood-Device-Id': ctx.deviceId || '',
    'Cache-Control': 'no-cache, no-store',
    'accept-language': 'pt-BR,pt;q=1',
    account_id: ctx.accountId || '',
    app_version: ctx.appVersion || '',
    'x-px-cookies': `_px3=${ctx.px3 || ''}; _pxvid=${ctx.pxvid || ''}; pxcts=${ctx.pxcts || ''}, true`,
    'x-ifood-user-id': ctx.accountId || ''
  };
}

function isLikelyMutationEndpoint(url: string): boolean {
  return /\/carts\b|\/checkout\b|\/place-order\b|\/orders\/create\b|\/payments?\b|\/transactions?\b|\/addresses\b/i.test(url);
}

function buildProbeUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (!url.searchParams.has('latitude')) url.searchParams.set('latitude', '-22.9130192');
  if (!url.searchParams.has('longitude')) url.searchParams.set('longitude', '-43.2381099');
  if (!url.searchParams.has('channel')) url.searchParams.set('channel', 'IFOOD');
  if (!url.searchParams.has('size')) url.searchParams.set('size', '1');
  if (!url.searchParams.has('term') && /search/i.test(url.pathname)) url.searchParams.set('term', 'pizza');
  return url.toString();
}

function pickMethod(methods: string[]): string {
  if (!methods || methods.length === 0) return 'GET';
  if (methods.includes('GET')) return 'GET';
  if (methods.includes('POST')) return 'POST';
  return methods[0];
}

function requiresCapturedPayload(endpoint: string, method: string): boolean {
  if (method !== 'POST') return false;
  return /\/v2\/bm\/home$|\/v1\/merchant-info\/graphql$/i.test(endpoint);
}

async function main() {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as SpecJson;
  const ctx = getSessionContext();

  if (!ctx.accessToken) {
    throw new Error('Sessao sem token. Faca login no iFood e rode novamente.');
  }

  const headers = commonHeaders(ctx);
  const results: any[] = [];

  for (const endpoint of spec.global.endpoints) {
    const mutation = endpoint.likelyMutation || isLikelyMutationEndpoint(endpoint.endpoint);
    if (mutation) {
      results.push({ endpoint: endpoint.endpoint, skipped: true, reason: 'mutation_endpoint' });
      continue;
    }

    const method = pickMethod(endpoint.methods || []);
    const url = buildProbeUrl(endpoint.endpoint);

    if (requiresCapturedPayload(endpoint.endpoint, method)) {
      results.push({
        endpoint: endpoint.endpoint,
        probeUrl: url,
        method,
        skipped: true,
        reason: 'requires_captured_payload'
      });
      continue;
    }

    try {
      const init: RequestInit = { method, headers };
      if (method === 'POST') {
        init.headers = { ...headers, 'Content-Type': 'application/json' };
        init.body = JSON.stringify({});
      }
      const res = await fetch(url, init);
      const reachable = res.status < 500;
      results.push({
        endpoint: endpoint.endpoint,
        probeUrl: url,
        method,
        status: res.status,
        ok: reachable,
        reachable,
        httpOk: res.ok
      });
    } catch (error) {
      results.push({
        endpoint: endpoint.endpoint,
        probeUrl: url,
        method,
        ok: false,
        error: String(error)
      });
    }
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length
  };

  mkdirSync(outputDir, { recursive: true });
  const reportPath = join(outputDir, 'ifood-open-api-probe-report.json');
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2));

  console.log(JSON.stringify({ ok: summary.failed === 0, summary, reportPath }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exit(1);
});
