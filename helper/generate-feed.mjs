// Збирає фід і кладе його у файл. Запускається на сервері за розкладом.
// Живе саме тут, а не на Vercel, бо магазин (платформа Cartum) ріже IP дата-центрів:
// звідти сотні запитів до карток товарів ловлять 429, а з цього сервера проходять.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildFeed, parseLive, parseStock, collectUnknown } from '../lib/build-feed.mjs';
import { fetchSiteStatuses } from '../lib/site-status.mjs';

const LIVE_URL = process.env.HOROSHOP_ROZETKA_FEED;
const STOCK_URL = process.env.HOROSHOP_STOCK_FEED;
const OUT = process.env.FEED_OUT || 'public/rozetka.xml';
const REFERENCE = new URL('../data/reference.json', import.meta.url);

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function fetchText(url, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'classyme-feed/1.0' } });
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.length < 500) throw new Error(`${label}: підозріло коротка відповідь`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function stamp(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).replace('T', ' ').slice(0, 16);
}

const reference = JSON.parse(readFileSync(REFERENCE, 'utf8'));
const [liveXml, stockXml] = await Promise.all([
  fetchText(LIVE_URL, 'живий фід'),
  fetchText(STOCK_URL, 'фід наявності'),
]);

const live = parseLive(liveXml);
const stock = parseStock(stockXml);
log(`джерела: живий фід ${live.count}, наявність ${stock.count}`);

// Тут не тиснемо на час: сервер не в дедлайні serverless-виклику,
// тому дочитуємо все, що потрібно, і робимо це неспішно.
const unknown = collectUnknown(reference, live, stock);
const { statuses, stats: siteStats } = await fetchSiteStatuses(unknown, {
  // Повільно і чемно: магазин ріже частоту, а нам поспішати нікуди —
  // фід оновлюється за розкладом, а не в момент запиту Rozetka.
  concurrency: 2,
  delayMs: 900,
  budgetMs: 900000,
  onRateLimit: 'wait',
  rateLimitPauseMs: 45000,
});
log(`сайт: ${siteStats.resolved}/${siteStats.requested} за ${siteStats.ms} мс` +
  (siteStats.rateLimited ? ' (спрацював ліміт частоти)' : ''));

const { xml, stats } = buildFeed({ reference, live, stock, siteStatus: statuses, now: stamp() });

// Не перезаписуємо робочий фід підозрілим результатом: якщо джерела підвели,
// краще лишити попередній файл, ніж зняти наявність з усього каталогу.
const covered = siteStats.requested ? siteStats.resolved / siteStats.requested : 1;
if (stats.total < 500) throw new Error(`у фіді лише ${stats.total} позицій — не оновлюємо`);
if (covered < 0.5 && siteStats.requested > 50) throw new Error(`сайт віддав лише ${Math.round(covered * 100)}% статусів — не оновлюємо`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, xml);
writeFileSync(dirname(OUT) + '/stats.json', JSON.stringify({ generated: stamp(), ...stats, site: siteStats }, null, 1));
log(`готово: ${stats.total} позицій (в наявності ${stats.inStock}, під замовлення ${stats.preorder}, немає ${stats.out}), ${Math.round(Buffer.byteLength(xml) / 1024)} КБ`);
