/**
 * Module: Norish API Adapter
 * Purpose: x-api-key-authenticated read-only client against a self-hosted
 *          Norish instance. Read-only mirror only - Norish remains the source
 *          of truth for recipe contents; this adapter only reads for mirroring
 *          (recipe-provider-sync.js). Implements the shared adapter interface
 *          documented in ./index.js.
 *
 *          Requests go through the SSRF-hardened client (server/utils/http.js)
 *          instead of global fetch(): base_url is admin-supplied and must pass
 *          the same anti-rebinding check (server/utils/ssrf.js) as WebDAV
 *          document storage and ICS subscriptions. RECIPE_PROVIDER_ALLOW_
 *          PRIVATE_NETWORK opts out (Docker-internal base_url). Separately,
 *          fetchThumbnail() pins the upstream-supplied image URL to this.base's
 *          origin before ever attaching the account's key to it - Norish's own
 *          API response is not trusted to name an arbitrary host
 *          (CWE-918/CWE-522).
 *
 *          Norish rate-limits per key; a 429 response carries a Retry-After
 *          header. The adapter throws with err.status = 429 so
 *          recipe-provider-sync.js can classify and surface it as the standard
 *          'recipe_providers_sync_http_status' reason (failure.js).
 * Dependencies: server/utils/http.js (SSRF-hardened HTTP client),
 *               server/utils/ssrf.js, ./categorize.js
 */
import { categorizeIngredient } from './categorize.js';
import { markupToText, servingsFrom } from './markup-text.js';
import { safeRequest } from '../../utils/http.js';
import { createGuardedLookup } from '../../utils/ssrf.js';
import { isPrivateNetworkAllowed, isPrivateNetworkRefusal } from './private-network.js';
import { probeFailure, ProviderResponseError } from './failure.js';

const REQUEST_TIMEOUT_MS = 8000;
const PAGE_SIZE = 50;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 20 * 1024 * 1024;

/**
 * Request options including timeout and (unless opted out) the anti-rebinding
 * lookup from ssrf.js - shared by #request/testConnection/fetchThumbnail so
 * none of the three can forget the guard.
 *
 * @param {Record<string, string>} [headers]
 * @returns {Record<string, any>}
 */
function guardedRequestOptions(headers) {
  /** @type {Record<string, any>} */
  const opts = { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (!isPrivateNetworkAllowed()) opts.lookup = createGuardedLookup();
  return opts;
}

/**
 * Drains safeRequest()'s body stream into a size-capped Buffer (idiom from
 * document-storage.js#readResponseBuffer) - there's no res.json()/
 * res.arrayBuffer() here, safeRequest hands back a raw Readable of Buffers.
 *
 * @param {any} res
 * @param {number} maxBytes
 * @param {string} tooLargeMessage
 * @returns {Promise<Buffer>}
 */
async function drainBody(res, maxBytes, tooLargeMessage) {
  const chunks = [];
  let total = 0;
  for await (const value of res.body) {
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      res.body.destroy();
      throw new ProviderResponseError(tooLargeMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * @param {any} res
 * @returns {Promise<any>}
 */
async function readJson(res) {
  const buffer = await drainBody(res, MAX_RESPONSE_BYTES, 'Norish response exceeds the 10 MB limit.');
  return JSON.parse(buffer.toString('utf8'));
}

/**
 * Norish recipeIngredient → flat { name, quantity, category }.
 * Norish represents a free-text ingredient line as { amount: null, unit: null,
 * ingredient: { name: '...' }, notes: '...' }. When amount is present and
 * non-zero, it is a number; unit is either null or { name: '...' }.
 *
 * @param {any} ing
 * @returns {{ name: string, quantity: string | null, category: string } | null}
 */
function flattenIngredient(ing) {
  if (!ing) return null;
  const foodName = (
    typeof ing.ingredient === 'string'
      ? ing.ingredient
      : ing.ingredient?.name || (typeof ing.food === 'string' ? ing.food : ing.food?.name) || ing.name
  )?.trim();
  const name = foodName || (ing.notes || ing.originalText || ing.display || '').trim() || '?';
  let quantity = null;
  const amount = ing.amount ?? ing.quantity;
  if (foodName && amount != null && amount !== 0) {
    const num = Number(amount);
    const formattedAmount = Number.isFinite(num)
      ? (Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100))
      : String(amount);
    const unitName = (typeof ing.unit === 'string' ? ing.unit : ing.unit?.name || ing.unit?.abbreviation)?.trim();
    quantity = unitName ? `${formattedAmount} ${unitName}` : formattedAmount;
  }
  const category = categorizeIngredient({ foodName });
  return { name, quantity, category };
}

/**
 * Norish steps (sorted by their `order` field) and description → `notes`
 * plain text. Norish step objects carry { order, text } where text may contain
 * Markdown or HTML from the editor. Runs through markupToText() as Mealie does.
 * Empty steps (whitespace only after strip) are dropped; they do not count in
 * the numbering. Description goes first, one blank line, then numbered steps.
 *
 * @param {any} detail
 * @returns {string | null}
 */
function composeNotes(detail) {
  const meta = [];
  const times = [];
  if (detail.prepTime) times.push(`Prep: ${detail.prepTime}`);
  if (detail.cookTime) times.push(`Cook: ${detail.cookTime}`);
  if (detail.totalTime) times.push(`Total: ${detail.totalTime}`);
  if (times.length) meta.push(times.join(' | '));

  const tags = [...(Array.isArray(detail.tags) ? detail.tags : []), ...(Array.isArray(detail.cuisines) ? detail.cuisines : [])]
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter(Boolean);
  if (tags.length) meta.push(`Tags: ${tags.join(', ')}`);

  const source = detail.source || detail.url;
  if (source) meta.push(`Source: ${source}`);

  const steps = Array.isArray(detail.steps)
    ? [...detail.steps]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((s) => {
          const title = markupToText(s?.title).replace(/\s+/g, ' ');
          const text = markupToText(s?.text || s?.instruction || s?.description).replace(/\n{2,}/g, '\n');
          return title && text ? `${title}: ${text}` : title || text;
        })
        .filter(Boolean)
        .map((line, i) => `${i + 1}. ${line}`)
    : [];

  const parts = [
    markupToText(detail.description),
    meta.join('\n'),
    steps.join('\n'),
  ].filter(Boolean);

  return parts.length ? parts.join('\n\n') : null;
}

/**
 * Picks the cover image from Norish's recipe detail. Norish exposes either
 * a top-level `image` string (absolute URL or path) or an `images` array of
 * { order, url } objects. We prefer the array, sorted by `order`, then fall
 * back to the top-level field.
 *
 * @param {any} detail
 * @returns {string | null}
 */
function pickImageUrl(detail) {
  if (Array.isArray(detail.images) && detail.images.length > 0) {
    const sorted = [...detail.images].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const first = sorted[0];
    return typeof first === 'string' ? first : first?.url || first?.path || null;
  }
  return detail.image || null;
}

/**
 * Extracts a combined update indicator from timestamp and/or version.
 * If Norish provides version or updatedAt/updated_at, changes to either
 * produce a new stamp, causing Yuvomi's sync to pull the fresh recipe.
 *
 * @param {any} item
 * @returns {string | null}
 */
function extractUpdatedAt(item) {
  const ts = item.updatedAt ?? item.updated_at;
  const version = item.version;
  if (ts && version != null) return `${ts}@v${version}`;
  if (ts) return String(ts);
  if (version != null) return `v${version}`;
  return null;
}

export class NorishAdapter {
  /**
   * @param {{ base_url?: string, api_token?: string, external_url?: string }} account
   */
  constructor(account) {
    this.provider = 'norish';
    // Stand der Abbildung getRecipe() -> recipes (siehe MealieAdapter/TandoorAdapter):
    // 1 = initial Norish adapter implementation.
    this.mirrorFormat = 1;
    this.base = String(account.base_url || '').replace(/\/+$/, '');
    this.token = account.api_token;
    // `external_url` is the optional publicly-reachable address for
    // "Open in Norish" links - falls back to base_url if not set.
    this.linkBase = String(account.external_url || account.base_url || '').replace(/\/+$/, '');
  }

  /**
   * Norish uses x-api-key header for authentication.
   *
   * @param {Record<string, string>} [extra]
   * @returns {Record<string, string>}
   */
  headers(extra = {}) {
    return { 'x-api-key': this.token || '', Accept: 'application/json', ...extra };
  }

  /**
   * @param {string} path
   * @param {{ headers?: Record<string, string> }} [opts]
   * @returns {Promise<any>}
   */
  async #request(path, opts = {}) {
    const reqOpts = { ...opts, ...guardedRequestOptions(this.headers(opts.headers)) };
    const res = await safeRequest(`${this.base}${path}`, reqOpts);
    if (!res.ok) {
      const err = Object.assign(new Error(`Norish request failed (${res.status})`), {
        status: res.status,
        retryAfter: res.headers?.get?.('retry-after') || null,
      });
      throw err;
    }
    return res;
  }

  // GET /api/v1/health proves the server is reachable and the key is valid.
  // Norish returns { status: "ok" } on success.
  async testConnection() {
    try {
      let res = await safeRequest(`${this.base}/api/v1/health`, guardedRequestOptions(this.headers()));
      if (res.status === 404) {
        res = await safeRequest(`${this.base}/api/v1/health/live`, guardedRequestOptions(this.headers()));
      }
      if (!res.ok) return { ok: false, status: res.status };
      const body = await readJson(res);
      if (body?.status !== 'ok') return { ok: false, status: res.status };
      return { ok: true, status: res.status };
    } catch (err) {
      const errorMsg = /** @type {any} */ (err)?.message;
      const error = isPrivateNetworkRefusal(errorMsg) ? errorMsg : 'The recipe provider could not be reached.';
      return { ok: false, status: 0, error, ...probeFailure(err) };
    }
  }

  // GET /api/v1/recipes returns a paginated list. Handles both cursor-based
  // and page-based pagination envelopes.
  async listRecipeSummaries() {
    const summaries = [];
    let page = 1;
    let done = false;

    while (!done) {
      const res = await this.#request(`/api/v1/recipes?page=${page}&limit=${PAGE_SIZE}`);
      const body = await readJson(res);

      const items = body.data ?? body.items ?? body.recipes ?? (Array.isArray(body) ? body : []);
      for (const item of items) {
        summaries.push({
          id: String(item.id),
          ref: String(item.id),
          updatedAt: extractUpdatedAt(item),
        });
      }

      if (body.nextCursor) {
        done = true;
      } else {
        const totalPages = body.meta?.lastPage ?? body.total_pages ?? body.totalPages ?? 1;
        if (page >= totalPages) {
          done = true;
        } else {
          page += 1;
        }
      }
    }
    return summaries;
  }

  /**
   * @param {string} ref
   * @returns {Promise<any>}
   */
  async getRecipe(ref) {
    const res = await this.#request(`/api/v1/recipes/${encodeURIComponent(ref)}`);
    const detail = await readJson(res);

    const imageUrl = pickImageUrl(detail);
    const rawServings = typeof detail.servings === 'number'
      ? detail.servings
      : (Number.isInteger(Number(detail.servings)) && Number(detail.servings) > 0
          ? Number(detail.servings)
          : (Number.isInteger(Number(detail.yield)) && Number(detail.yield) > 0 ? Number(detail.yield) : null));

    return {
      id: String(detail.id),
      updatedAt: extractUpdatedAt(detail),
      slug: imageUrl || null,
      title: detail.name || detail.title,
      notes: composeNotes(detail),
      hasImage: Boolean(imageUrl),
      servings: servingsFrom(rawServings),
      ingredients: (detail.recipeIngredients || []).map(flattenIngredient).filter(Boolean),
    };
  }

  // Norish recipe view URL: /recipes/{id}
  // linkContext is unused (Norish has no group/space segment like Mealie),
  // kept in the signature to satisfy the shared adapter interface.
  /**
   * @param {any} _linkContext
   * @param {{ id: string }} param1
   * @returns {string}
   */
  recipeUrl(_linkContext, { id }) {
    return `${this.linkBase}/recipes/${encodeURIComponent(id)}`;
  }

  /**
   * @param {{ slug: string | null }} param0
   * @returns {Promise<{ buffer: Buffer, mime: string }>}
   */
  async fetchThumbnail({ slug }) {
    if (!slug) {
      const err = Object.assign(new Error('Norish thumbnail request failed (no image path)'), { status: 404 });
      throw err;
    }
    let url;
    if (/^https?:\/\//i.test(slug)) {
      if (new URL(slug).origin !== new URL(this.base).origin) {
        const err = Object.assign(
          new Error('Norish thumbnail image host does not match the configured account'),
          { status: 502 },
        );
        throw err;
      }
      url = slug;
    } else {
      url = `${this.base}${slug.startsWith('/') ? '' : '/'}${slug}`;
    }
    const res = await safeRequest(url, guardedRequestOptions(this.headers({ Accept: 'image/*' })));
    if (!res.ok) {
      const err = Object.assign(new Error(`Norish thumbnail request failed (${res.status})`), { status: res.status });
      throw err;
    }
    const buffer = await drainBody(res, MAX_THUMBNAIL_BYTES, 'Norish thumbnail exceeds the 20 MB limit.');
    return { buffer, mime: res.headers.get('content-type') || 'image/jpeg' };
  }
}
