// Резервне джерело статусів: читає картку товару на сайті.
// Потрібне тому, що фіди Хорошопа неповні — Rozetka-фід віддає 525 позицій із 648,
// Google-фід 446, причому набори різні. Сайт знає про кожен товар.
// Використовується лише для позицій, про які мовчать обидва фіди.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

// Сайт закритий JS-челенджем. Хеш лежить у самому скрипті й змінюється,
// тому дістаємо його щоразу, а не зашиваємо в код.
export async function getChallengeCookie(origin = 'https://classyme.com.ua') {
  const res = await fetch(origin + '/', { headers: { 'user-agent': UA } });
  const html = await res.text();
  const m = html.match(/defaultHash\s*=\s*"([a-f0-9]{32,})"/i);
  return m ? m[1] : null;
}

const STATUS_RE = /product-header__availability[^>]*>\s*([^<]+)</i;

export const SITE_STATUS = {
  IN_STOCK: 'В наявності',
  PREORDER: 'Під замовлення',
  OUT: 'Немає в наявності',
  EXPECTED: 'Очікується',
};

export function parseStatus(html) {
  const m = html.match(STATUS_RE);
  return m ? m[1].trim() : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Магазин на Cartum обмежує частоту: 21 запит/с миттєво дає 429 на весь сайт.
// Тому ходимо повільно й помітно менш агресивно, ніж дозволяє Vercel.
// Підібрано дослідно: 6 потоків із паузою 150 мс дають ~13 запитів/с і ловлять 429
// з IP дата-центру. 4 потоки з паузою 300 мс — це ~6 запитів/с, магазин таке терпить.
export const RATE = { concurrency: 4, delayMs: 300 };

async function fetchOnce(url, cookie, timeoutMs, state) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, cookie: 'challenge_passed=' + cookie },
      signal: ctrl.signal,
    });
    // 429 означає, що нас пригальмували: далі довбати сайт не можна.
    if (res.status === 429) {
      if (state) state.rateLimited = true;
      return null;
    }
    if (!res.ok) return null;
    return parseStatus(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// З дата-центру частина запитів зривається (локально — жодного), тому один повтор.
async function fetchOne(url, cookie, timeoutMs, state) {
  const first = await fetchOnce(url, cookie, timeoutMs, state);
  if (first || state?.rateLimited) return first;
  await sleep(300);
  return fetchOnce(url, cookie, timeoutMs, state);
}

// Свідомо м'яка функція: усе, що не встигли або не змогли прочитати, просто
// не потрапляє в результат — виклик має деградувати, а не валити збірку фіда.
export async function fetchSiteStatuses(urls, opts = {}) {
  const {
    concurrency = RATE.concurrency,
    timeoutMs = 8000,
    budgetMs = 25000,
    delayMs = RATE.delayMs,
    // 'stop' — впертись у 429 і віддати що є (serverless, часу нема).
    // 'wait' — перечекати й продовжити (сервер за розкладом, часу вдосталь).
    onRateLimit = 'stop',
    rateLimitPauseMs = 60000,
    origin,
  } = opts;
  const result = new Map();
  const stats = { requested: urls.length, resolved: 0, failed: 0, skipped: 0, rateLimited: false, rateLimitHits: 0, ms: 0 };
  if (!urls.length) return { statuses: result, stats };

  const started = Date.now();
  let cookieCache = null;
  let cookie = null;
  try {
    cookie = await getChallengeCookie(origin);
  } catch {
    cookie = null;
  }
  if (!cookie) {
    stats.skipped = urls.length;
    stats.ms = Date.now() - started;
    return { statuses: result, stats };
  }

  const queue = [...urls];
  const state = { rateLimited: false };
  const worker = async () => {
    while (queue.length) {
      // Ліміт часу або бан від магазину — зупиняємось і віддаємо те, що встигли.
      if (Date.now() - started > budgetMs || state.rateLimited) {
        stats.skipped += queue.length;
        queue.length = 0;
        break;
      }
      const url = queue.shift();
      let status = await fetchOne(url, cookie, timeoutMs, state);

      if (state.rateLimited && onRateLimit === 'wait') {
        // Магазин пригальмував — чекаємо, оновлюємо куку й пробуємо цю ж позицію ще раз.
        stats.rateLimitHits++;
        await sleep(rateLimitPauseMs);
        state.rateLimited = false;
        cookieCache = null;
        const fresh = await getChallengeCookie(origin).catch(() => null);
        if (fresh) cookie = fresh;
        status = await fetchOne(url, cookie, timeoutMs, state);
        if (state.rateLimited) { queue.unshift(url); continue; }
      }

      if (status) {
        result.set(url, status);
        stats.resolved++;
      } else {
        stats.failed++;
      }
      await sleep(delayMs);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  stats.rateLimited = state.rateLimited;
  stats.ms = Date.now() - started;
  return { statuses: result, stats };
}
