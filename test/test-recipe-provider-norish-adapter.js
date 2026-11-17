/**
 * Module: Recipe Provider Adapter Test (Norish)
 * Purpose: Validates NorishAdapter (testConnection, listRecipeSummaries, getRecipe,
 *          recipeUrl, fetchThumbnail, rate-limiting, error handling) against a local
 *          HTTP test server.
 * Run: node --test test/test-recipe-provider-norish-adapter.js
 */
import assert from 'node:assert/strict';
import test, { before, after, beforeEach } from 'node:test';
import http from 'node:http';
import { NorishAdapter } from '../server/services/recipe-providers/norish.js';
import { classifyProviderFailure, ProviderResponseError } from '../server/services/recipe-providers/failure.js';

const ENV_FLAG = 'RECIPE_PROVIDER_ALLOW_PRIVATE_NETWORK';

/** @type {Array<{ url: string, method: string, body: any, opts: { headers: Record<string, string | string[] | undefined> } }>} */
let calls;
/** @type {(req: http.IncomingMessage, res: http.ServerResponse) => void} */
let handler;
/** @type {http.Server} */
let server;
/** @type {string} */
let base;
/** @type {{ base_url: string, api_token: string }} */
let account;

before(async () => {
  process.env[ENV_FLAG] = 'true';
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({
        url: `${base}${req.url}`,
        method: req.method || '',
        body: raw ? JSON.parse(raw) : null,
        opts: { headers: {
          'x-api-key': req.headers['x-api-key'],
          accept: req.headers.accept,
          'content-type': req.headers['content-type'],
        } },
      });
      handler(req, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = server.address();
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  account = { base_url: base, api_token: 'norish-key-123' };
});

after(async () => {
  delete process.env[ENV_FLAG];
  await new Promise((resolve) => server.close(() => resolve(undefined)));
});

beforeEach(() => {
  calls = [];
  handler = (_req, res) => { res.writeHead(500); res.end(); };
});

/**
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} fn
 */
function mockHandler(fn) {
  handler = fn;
}

/**
 * @param {http.ServerResponse} res
 * @param {any} body
 * @param {number} [status]
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, body, status = 200, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(buf.length), ...headers });
  res.end(buf);
}

/**
 * @param {http.ServerResponse} res
 * @param {Buffer} buffer
 * @param {string} mime
 * @param {number} [status]
 */
function sendBinary(res, buffer, mime, status = 200) {
  res.writeHead(status, { 'Content-Type': mime, 'Content-Length': String(buffer.length) });
  res.end(buffer);
}

async function deadBaseUrl() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = s.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise((r) => s.close(() => r(undefined)));
  return `http://127.0.0.1:${port}`;
}

test('Konstruktor entfernt trailing slash von base_url', () => {
  const adapter = new NorishAdapter({ ...account, base_url: `${base}/` });
  assert.equal(adapter.base, base);
});

// --------------------------------------------------------------------------
// Fixtures follow the Norish 0.25.1 OpenAPI spec (apps/docs/.../reference/openapi.json):
//   POST /api/v1/recipes/search -> { recipes, total, nextCursor }  (cursor = integer offset)
//   GET  /api/v1/recipes/{id}   -> recipe with recipeIngredients[{ amount, unit, ingredientName }],
//                                  steps[{ step, order }], images[{ image, order }],
//                                  prepMinutes / cookMinutes / totalMinutes, tags[{ name }]
// --------------------------------------------------------------------------

/**
 * @param {Array<Record<string, any>>} recipes
 * @param {number | null} nextCursor
 * @param {number} [total]
 */
function searchPage(recipes, nextCursor, total = recipes.length) {
  return { recipes, total, nextCursor };
}

// --------------------------------------------------------------------------
// Auth: x-api-key header on every request
// --------------------------------------------------------------------------

test('x-api-key header wird bei jedem Request gesetzt', async () => {
  mockHandler((req, res) => sendJson(res, searchPage([], null)));
  const adapter = new NorishAdapter(account);
  await adapter.listRecipeSummaries();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers['x-api-key'], 'norish-key-123');
});

// --------------------------------------------------------------------------
// testConnection: an authenticated one-row search (/api/v1/health needs no key)
// --------------------------------------------------------------------------

test('testConnection: ok=true bei 200 auf POST /api/v1/recipes/search mit limit 1', async () => {
  mockHandler((req, res) => sendJson(res, searchPage([], null, 0)));
  const adapter = new NorishAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${base}/api/v1/recipes/search`);
  assert.equal(calls[0].opts.headers['x-api-key'], 'norish-key-123');
  assert.deepEqual(calls[0].body, { cursor: 0, limit: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
});

test('testConnection: ok=false bei 401 (falscher Schlüssel) ohne Wurf', async () => {
  mockHandler((req, res) => sendJson(res, { code: 'UNAUTHORIZED', message: 'You must be logged in to access this resource' }, 401));
  const adapter = new NorishAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
});

test('testConnection: ok=false wenn die Antwort keine recipes-Liste enthält', async () => {
  mockHandler((req, res) => sendJson(res, { status: 'ok' }, 200));
  const adapter = new NorishAdapter(account);
  const out = await adapter.testConnection();
  assert.equal(out.ok, false);
});

test('testConnection: Netzwerkfehler meldet ok=false, status=0 und standard reason', async () => {
  const adapter = new NorishAdapter({ ...account, base_url: await deadBaseUrl() });
  /** @type {any} */
  const out = await adapter.testConnection();
  assert.equal(out.ok, false);
  assert.equal(out.status, 0);
  assert.equal(out.error, 'The recipe provider could not be reached.');
  assert.equal(out.reason, 'recipe_providers_sync_unreachable');
});

// --------------------------------------------------------------------------
// listRecipeSummaries
// --------------------------------------------------------------------------

test('listRecipeSummaries: POST /recipes/search und folgt nextCursor bis null', async () => {
  mockHandler((req, res) => {
    const { cursor } = calls[calls.length - 1].body;
    if (cursor === 0) {
      return sendJson(res, searchPage([
        { id: 'uuid-1', updatedAt: '2026-11-01T10:00:00Z', version: 1 },
        { id: 'uuid-2', updatedAt: '2026-11-01T11:00:00Z' },
      ], 2, 3));
    }
    if (cursor === 2) {
      return sendJson(res, searchPage([{ id: 'uuid-3', version: 4 }], null, 3));
    }
    throw new Error(`Unerwarteter Cursor: ${cursor}`);
  });

  const adapter = new NorishAdapter(account);
  const summaries = await adapter.listRecipeSummaries();
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.method, 'POST');
    assert.equal(c.url, `${base}/api/v1/recipes/search`);
    assert.equal(c.opts.headers['content-type'], 'application/json');
  }
  assert.deepEqual(calls.map((c) => c.body), [{ cursor: 0, limit: 50 }, { cursor: 2, limit: 50 }]);
  assert.deepEqual(summaries.map((s) => s.id), ['uuid-1', 'uuid-2', 'uuid-3']);
  assert.deepEqual(summaries.map((s) => s.ref), ['uuid-1', 'uuid-2', 'uuid-3']);
  // Incremental updates: version is combined with updatedAt when present
  assert.deepEqual(summaries.map((s) => s.updatedAt), [
    '2026-11-01T10:00:00Z@v1',
    '2026-11-01T11:00:00Z',
    'v4',
  ]);
});

test('listRecipeSummaries: eine Seite mit nextCursor null macht genau einen Request', async () => {
  mockHandler((req, res) => sendJson(res, searchPage([{ id: 'only-1', updatedAt: '2026-11-01T00:00:00Z' }], null)));
  const adapter = new NorishAdapter(account);
  const summaries = await adapter.listRecipeSummaries();
  assert.equal(calls.length, 1);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, 'only-1');
});

test('listRecipeSummaries: leere Instanz liefert eine leere Liste', async () => {
  mockHandler((req, res) => sendJson(res, searchPage([], null, 0)));
  const adapter = new NorishAdapter(account);
  assert.deepEqual(await adapter.listRecipeSummaries(), []);
  assert.equal(calls.length, 1);
});

test('listRecipeSummaries: ein Cursor, der nicht weiterläuft, beendet die Schleife', async () => {
  mockHandler((req, res) => sendJson(res, searchPage([{ id: 'loop-1' }], 0, 5)));
  const adapter = new NorishAdapter(account);
  const summaries = await adapter.listRecipeSummaries();
  assert.equal(calls.length, 1);
  assert.equal(summaries.length, 1);
});

test('listRecipeSummaries: 404 wirft mit status=404 statt still leer zu bleiben', async () => {
  mockHandler((req, res) => sendJson(res, { code: 'NOT_FOUND' }, 404));
  const adapter = new NorishAdapter(account);
  await assert.rejects(() => adapter.listRecipeSummaries(), (err) => /** @type {any} */ (err).status === 404);
});

// --------------------------------------------------------------------------
// getRecipe: schema mapping
// --------------------------------------------------------------------------

test('getRecipe: bildet alle Felder ab (Name, Notes mit Markdown/Steps, Portionen, Zutaten)', async () => {
  mockHandler((req, res) => sendJson(res, {
    id: 'uuid-rec-1',
    name: 'Norish Pasta',
    description: 'A **classic** Italian *dish*.',
    prepMinutes: 15,
    cookMinutes: 20,
    totalMinutes: null,
    tags: [{ name: 'Italian', version: 1 }, { name: 'Quick', version: 1 }],
    cuisines: [],
    url: 'https://recipes.example.com/pasta',
    servings: 4,
    updatedAt: '2026-11-10T12:00:00Z',
    version: 2,
    image: null,
    images: [
      { id: '00000000-0000-0000-0000-000000000002', order: 2, image: 'https://example.com/ignored.jpg', generated: false, version: 1 },
      { id: '00000000-0000-0000-0000-000000000001', order: 1, image: '/uploads/recipes/pasta-cover.jpg', generated: false, version: 1 },
    ],
    steps: [
      { order: 2, step: 'Cook pasta in **salted** water.', systemUsed: 'metric', version: 1, images: [], stepIngredients: [] },
      { order: 1, step: 'Bring 4L of water to a boil.', systemUsed: 'metric', version: 1, images: [], stepIngredients: [] },
    ],
    recipeIngredients: [
      { id: '00000000-0000-0000-0000-0000000000a1', order: 0, ingredientName: 'Pasta', amount: 500, unit: 'g' },
      { id: '00000000-0000-0000-0000-0000000000a2', order: 1, ingredientName: 'Salt', amount: 1.5, unit: 'tsp' },
      { id: '00000000-0000-0000-0000-0000000000a3', order: 2, ingredientName: 'Fresh parsley', amount: null, unit: null },
    ],
  }));

  const adapter = new NorishAdapter(account);
  const recipe = await adapter.getRecipe('uuid-rec-1');

  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `${base}/api/v1/recipes/uuid-rec-1`);
  assert.equal(recipe.id, 'uuid-rec-1');
  assert.equal(recipe.title, 'Norish Pasta');
  assert.equal(recipe.updatedAt, '2026-11-10T12:00:00Z@v2');
  assert.equal(recipe.servings, 4);
  assert.equal(recipe.hasImage, true);
  // Prefers lowest order in images array
  assert.equal(recipe.slug, '/uploads/recipes/pasta-cover.jpg');

  // Notes contains description, metadata (times, tags, source), and numbered steps
  assert.match(recipe.notes, /^A classic Italian dish\./);
  assert.match(recipe.notes, /Prep: 15 min \| Cook: 20 min/);
  assert.doesNotMatch(recipe.notes, /Total:/);
  assert.match(recipe.notes, /Tags: Italian, Quick/);
  assert.match(recipe.notes, /Source: https:\/\/recipes\.example\.com\/pasta/);
  assert.match(recipe.notes, /1\. Bring 4L of water to a boil\./);
  assert.match(recipe.notes, /2\. Cook pasta in salted water\./);

  // Ingredients mapped from ingredientName / amount / unit - never the '?' placeholder
  assert.equal(recipe.ingredients.length, 3);
  assert.deepEqual(recipe.ingredients[0], { name: 'Pasta', quantity: '500 g', category: 'Backwaren' });
  assert.deepEqual(recipe.ingredients[1], { name: 'Salt', quantity: '1.5 tsp', category: 'Sonstiges' });
  assert.deepEqual(recipe.ingredients[2], { name: 'Fresh parsley', quantity: null, category: 'Obst & Gemüse' });
  assert.ok(recipe.ingredients.every((i) => i.name !== '?'));
});

test('getRecipe: Zutaten und Schritte erscheinen nur einmal, im Einheitensystem des Rezepts', async () => {
  // Norish speichert jede Zeile je Einheitensystem (metric und us) - ohne Filter stünde alles doppelt da.
  mockHandler((req, res) => sendJson(res, {
    id: 'uuid-rec-4',
    name: 'Cacio e Pere',
    systemUsed: 'metric',
    servings: 2,
    steps: [
      { order: 1, step: 'Boil the pasta.', systemUsed: 'metric', version: 1, images: [], stepIngredients: [] },
      { order: 1, step: 'Boil the pasta.', systemUsed: 'us', version: 1, images: [], stepIngredients: [] },
      { order: 2, step: 'Toss with Pecorino.', systemUsed: 'metric', version: 1, images: [], stepIngredients: [] },
      { order: 2, step: 'Toss with Pecorino.', systemUsed: 'us', version: 1, images: [], stepIngredients: [] },
    ],
    recipeIngredients: [
      { order: 0, ingredientName: 'pasta', amount: 80, unit: 'gram', systemUsed: 'metric' },
      { order: 0, ingredientName: 'pasta', amount: 2.82, unit: 'ounce', systemUsed: 'us' },
      { order: 1, ingredientName: 'ripe pear', amount: 1, unit: null, systemUsed: 'metric' },
      { order: 1, ingredientName: 'ripe pear', amount: 1, unit: null, systemUsed: 'us' },
    ],
  }));
  const adapter = new NorishAdapter(account);
  const recipe = await adapter.getRecipe('uuid-rec-4');
  assert.deepEqual(recipe.ingredients.map((i) => `${i.quantity} ${i.name}`), ['80 gram pasta', '1 ripe pear']);
  assert.equal((recipe.notes.match(/Boil the pasta\./g) || []).length, 1);
  assert.match(recipe.notes, /1\. Boil the pasta\.\n2\. Toss with Pecorino\./);
});

test('getRecipe: ein US-Rezept behält die US-Zeilen', async () => {
  mockHandler((req, res) => sendJson(res, {
    id: 'uuid-rec-5',
    name: 'Biscuits',
    systemUsed: 'us',
    recipeIngredients: [
      { order: 0, ingredientName: 'flour', amount: 250, unit: 'gram', systemUsed: 'metric' },
      { order: 0, ingredientName: 'flour', amount: 2, unit: 'cup', systemUsed: 'us' },
    ],
  }));
  const adapter = new NorishAdapter(account);
  const recipe = await adapter.getRecipe('uuid-rec-5');
  assert.deepEqual(recipe.ingredients.map((i) => i.quantity), ['2 cup']);
});

test('getRecipe: Zeilen ohne systemUsed-Feld bleiben vollständig erhalten', async () => {
  mockHandler((req, res) => sendJson(res, {
    id: 'uuid-rec-6',
    name: 'Soup',
    recipeIngredients: [
      { order: 0, ingredientName: 'water', amount: 1, unit: 'litre' },
      { order: 1, ingredientName: 'salt', amount: null, unit: null },
    ],
  }));
  const adapter = new NorishAdapter(account);
  const recipe = await adapter.getRecipe('uuid-rec-6');
  assert.equal(recipe.ingredients.length, 2);
});

test('getRecipe: ohne images-Array dient das Feld image als Titelbild', async () => {
  mockHandler((req, res) => sendJson(res, {
    id: 'uuid-rec-2',
    name: 'Pancakes',
    servings: 6,
    images: [],
    image: '/media/pancakes.png',
  }));
  const adapter = new NorishAdapter(account);
  const recipe = await adapter.getRecipe('uuid-rec-2');
  assert.equal(recipe.servings, 6);
  assert.equal(recipe.slug, '/media/pancakes.png');
});

test('getRecipe: ungültige Portionen (0, negativ, Dezimalbruch) werden zu null', async () => {
  mockHandler((req, res) => sendJson(res, {
    id: 'uuid-rec-3',
    name: 'Cake',
    servings: 0,
  }));
  const adapter = new NorishAdapter(account);
  const recipe = await adapter.getRecipe('uuid-rec-3');
  assert.equal(recipe.servings, null);
});

// --------------------------------------------------------------------------
// recipeUrl
// --------------------------------------------------------------------------

test('recipeUrl: baut /recipes/{id}', () => {
  const adapter = new NorishAdapter(account);
  assert.equal(adapter.recipeUrl(null, { id: 'uuid-123' }), `${base}/recipes/uuid-123`);
});

test('recipeUrl: nutzt external_url statt base_url wenn gesetzt', () => {
  const adapter = new NorishAdapter({ ...account, external_url: 'https://norish.family.local/' });
  assert.equal(adapter.recipeUrl(null, { id: 'abc' }), 'https://norish.family.local/recipes/abc');
});

// --------------------------------------------------------------------------
// fetchThumbnail
// --------------------------------------------------------------------------

test('fetchThumbnail: fehlender slug wirft 404', async () => {
  const adapter = new NorishAdapter(account);
  await assert.rejects(
    () => adapter.fetchThumbnail({ slug: null }),
    (err) => {
      assert.equal(/** @type {any} */ (err).status, 404);
      return true;
    },
  );
});

test('fetchThumbnail: lädt relatives Bild von base_url', async () => {
  const buf = Buffer.from('FAKE-JPEG-DATA');
  mockHandler((req, res) => sendBinary(res, buf, 'image/jpeg'));
  const adapter = new NorishAdapter(account);
  const out = await adapter.fetchThumbnail({ slug: '/uploads/cover.jpg' });
  assert.equal(calls[0].url, `${base}/uploads/cover.jpg`);
  assert.equal(calls[0].opts.headers['x-api-key'], 'norish-key-123');
  assert.equal(out.mime, 'image/jpeg');
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.equal(out.buffer.toString(), 'FAKE-JPEG-DATA');
});

test('fetchThumbnail: absolute URL auf eigenem Host wird erlaubt', async () => {
  const buf = Buffer.from('FAKE-WEBP-DATA');
  mockHandler((req, res) => sendBinary(res, buf, 'image/webp'));
  const adapter = new NorishAdapter(account);
  const out = await adapter.fetchThumbnail({ slug: `${base}/uploads/cover.webp` });
  assert.equal(calls[0].url, `${base}/uploads/cover.webp`);
  assert.equal(out.mime, 'image/webp');
});

test('fetchThumbnail: abweichender Host bei absoluter URL wird mit 502 abgewiesen (SSRF Guard)', async () => {
  const adapter = new NorishAdapter(account);
  await assert.rejects(
    () => adapter.fetchThumbnail({ slug: 'https://evil.attacker.org/token-theft.png' }),
    (err) => {
      assert.equal(/** @type {any} */ (err).status, 502);
      assert.match(/** @type {any} */ (err).message, /does not match the configured account/);
      return true;
    },
  );
});

// --------------------------------------------------------------------------
// Fehlerbehandlung & Rate Limits (401, 429, etc.)
// --------------------------------------------------------------------------

test('Fehlerbehandlung: 401 wirft Fehler mit status=401 und klassifiziert als auth_failed', async () => {
  mockHandler((req, res) => sendJson(res, { error: 'Invalid API key' }, 401));
  const adapter = new NorishAdapter(account);
  /** @type {any} */
  const err = await adapter.listRecipeSummaries().catch((e) => e);
  assert.equal(err.status, 401);
  assert.deepEqual(classifyProviderFailure(err), { reason: 'recipe_providers_sync_auth_failed' });
});

test('Fehlerbehandlung: 429 Too Many Requests wirft mit status=429 und Retry-After', async () => {
  mockHandler((req, res) => sendJson(res, { error: 'Rate limit exceeded' }, 429, { 'retry-after': '60' }));
  const adapter = new NorishAdapter(account);
  /** @type {any} */
  const err = await adapter.listRecipeSummaries().catch((e) => e);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, '60');
  assert.deepEqual(classifyProviderFailure(err), {
    reason: 'recipe_providers_sync_http_status',
    params: { status: 429 },
  });
});

test('Fehlerbehandlung: unlesbares JSON klassifiziert als bad_response', async () => {
  mockHandler((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('invalid-json{{{');
  });
  const adapter = new NorishAdapter(account);
  const err = await adapter.listRecipeSummaries().catch((e) => e);
  assert.ok(err instanceof SyntaxError);
  assert.deepEqual(classifyProviderFailure(err), { reason: 'recipe_providers_sync_bad_response' });
});

test('Fehlerbehandlung: Antwort > 10MB wirft ProviderResponseError', async () => {
  const big = Buffer.alloc(10 * 1024 * 1024 + 10, 0x20);
  mockHandler((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(big);
  });
  const adapter = new NorishAdapter(account);
  const err = await adapter.listRecipeSummaries().catch((e) => e);
  assert.ok(err instanceof ProviderResponseError);
  assert.deepEqual(classifyProviderFailure(err), { reason: 'recipe_providers_sync_bad_response' });
});
