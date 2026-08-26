// Збирає фід для Rozetka: скелет карток бере з еталона, наявність і ціни — з живих фідів Хорошопа.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
  // Фіди Хорошопа містять тисячі сутностей, вбудований ліміт розкриття (1000) на них падає.
  processEntities: false,
});

// Описи товарів у Хорошопі редагуються візуальним редактором, тому рясніють
// HTML-сутностями. Усередині CDATA вони не розкриються — декодуємо самі.
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', mdash: '—', ndash: '–',
  hellip: '…', bull: '•', middot: '·', deg: '°',
  laquo: '«', raquo: '»', times: '×', minus: '−',
  copy: '©', reg: '®', trade: '™', euro: '€',
  sect: '§', para: '¶', dagger: '†', permil: '‰',
  prime: '′', frac12: '½', frac14: '¼', frac34: '¾',
  plusmn: '±', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ',
}

export function decodeEntities(s) {
  if (s == null) return s;
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

const txt = (v) => (v == null ? null : decodeEntities(String(v)));
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const urlId = (url) => (String(url || '').match(/\/(\d+)\/?$/) || [])[1] || null;
const normUrl = (url) => String(url || '').trim().replace(/\/+$/, '').toLowerCase();

const SIZES = ['XXXL', 'XXL', 'XL', 'XS', 'S', 'M', 'L'];

// Артикул у живому фіді — базовий артикул плюс суфікс розміру: 4jg-s, 31d-wxs.
export function splitArticle(id) {
  const a = String(id || '').trim();
  for (const s of SIZES) {
    if (a.toUpperCase().endsWith(s)) {
      return { base: a.slice(0, a.length - s.length).replace(/-$/, ''), size: s };
    }
  }
  return { base: a, size: null };
}

// Категорію нового товару визначаємо за назвою — інших даних живий фід не дає.
const CATEGORY_RULES = [
  [/дублянк|куртк|пальт|шуб|пуховик|бомбер|тренч|жилет|шкірянк|косух/i, 'верхній одяг'],
  [/сукн|плать/i, 'сукні'],
  [/джинс/i, 'джинси'],
  [/спідниц|шорт/i, 'спідниці'],
  [/футболк|лонг|світшот|худі|реглан/i, 'футболки'],
  [/корсет|топ /i, 'топи'],
  [/боді/i, 'боді'],
  [/костюм|брюк|штан|кардиган|жакет|піджак|сорочк|блуз/i, 'верх'],
  [/термо|комбінезон/i, 'термокомбінезони'],
];

export function pickCategory(name, categories) {
  const lower = String(name || '').toLowerCase();
  for (const [re, key] of CATEGORY_RULES) {
    if (!re.test(lower)) continue;
    const hit = categories.find((c) => c.name.toLowerCase().includes(key));
    if (hit) return hit.id;
  }
  return categories[0]?.id ?? '';
}

export function parseLive(xml) {
  const doc = parser.parse(xml);
  const raw = arr(doc?.yml_catalog?.shop?.offers?.offer);
  const offers = [];
  const byUrlId = new Map();
  const byUrl = new Map();

  for (const o of raw) {
    const item = {
      id: txt(o['@id']),
      available: String(o['@available']) === 'true',
      url: txt(o.url) || '',
      price: o.price != null ? String(o.price) : null,
      priceOld: o.price_old != null ? String(o.price_old) : null,
      name: txt(o.name),
      description: txt(o.description),
      pictures: arr(o.picture).map(txt),
      params: arr(o.param).map((p) => ({
        name: txt(p['@name']) || '',
        value: txt(p['#text'] ?? p) ?? '',
      })),
    };
    offers.push(item);
    const uid = urlId(item.url);
    if (uid) byUrlId.set(uid, item);
    byUrl.set(normUrl(item.url), item);
  }

  return { offers, byUrlId, byUrl, count: offers.length };
}

export function parseStock(xml) {
  const doc = parser.parse(xml);
  const items = arr(doc?.rss?.channel?.item);
  const byId = new Map();
  const byUrlId = new Map();
  const byUrl = new Map();

  for (const i of items) {
    const inStock = String(i.availability || '') === 'in stock';
    const link = txt(i.link) || '';
    byId.set(txt(i.id), inStock);
    // Посилання те саме, що й у еталона, — дає збіг навіть без пари в живому фіді.
    const uid = urlId(link);
    if (uid) byUrlId.set(uid, inStock);
    if (link) byUrl.set(normUrl(link), inStock);
  }

  return { byId, byUrlId, byUrl, count: items.length };
}

// Статуси, зчитані з карток сайту, мають пріоритет над фідами: сайт — першоджерело,
// саме там замовниця міняє наявність руками.
const SITE_TO_STATE = {
  'В наявності': 'in_stock',
  'Під замовлення': 'preorder',
  'Немає в наявності': 'out',
  'Очікується': 'preorder',
};

export function lookupSite(siteStatus, url) {
  if (!siteStatus || !siteStatus.size) return null;
  const raw = siteStatus.get(url) ?? siteStatus.get(normUrl(url));
  if (!raw) return null;
  return SITE_TO_STATE[raw] ?? null;
}

// Шукає наявність по артикулу, потім по ID у посиланні, потім по самому посиланню.
export function lookupStock(stock, { articleId, refId, url }) {
  if (articleId != null && stock.byId.has(articleId)) {
    return { known: true, inStock: stock.byId.get(articleId) };
  }
  if (refId != null && stock.byUrlId?.has(refId)) {
    return { known: true, inStock: stock.byUrlId.get(refId) };
  }
  const key = normUrl(url);
  if (key && stock.byUrl?.has(key)) {
    return { known: true, inStock: stock.byUrl.get(key) };
  }
  return { known: false, inStock: false };
}

const esc = (s) =>
  String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

const cdata = (s) => '<![CDATA[' + String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';

// Три стани, які просив замовник: є / під замовлення / немає.
// KEEP — джерела нічого не знають про товар, чіпати його не можна.
export const STATE = { IN_STOCK: 'in_stock', PREORDER: 'preorder', OUT: 'out', KEEP: 'keep' };

// Живий фід Хорошопа неповний: у ньому 525 позицій із 648, і 83% відсутніх
// насправді активні. Тому відсутність у фіді сама по собі не знімає товар з продажу —
// потрібне явне підтвердження від джерела наявності.
//
// Напрямок підстраховки: коли джерело наявності мовчить, товар іде як «під замовлення»,
// а не «в наявності». Продати те, чого немає, коштує дорожче: Rozetka рахує скасування
// з вини продавця і ховає вітрину з видачі. Непродана позиція — лише втрачена конверсія.
export function resolveState(live, stockKnown, inStock) {
  if (live && live.available) {
    if (stockKnown) return inStock ? STATE.IN_STOCK : STATE.PREORDER;
    return STATE.PREORDER;
  }
  if (live && !live.available) return STATE.OUT;
  // Товару немає серед активних позицій сайту І джерело наявності каже «немає» —
  // два незалежні сигнали, цього досить, щоб зняти з продажу.
  if (stockKnown) return inStock ? STATE.IN_STOCK : STATE.OUT;
  return STATE.KEEP;
}

// Список сторінок, які треба прочитати з сайту: лише ті товари, про наявність яких
// фіди нічого не кажуть. Решту закривають фіди — одним запитом замість сотень.
export function collectUnknown(reference, live, stock) {
  const urls = new Set();

  for (const [id, ref] of Object.entries(reference.offers)) {
    const liveItem = live.byUrlId.get(id) ?? live.byUrl.get(normUrl(ref.url));
    const { known, inStock } = lookupStock(stock, {
      articleId: liveItem?.id ?? null,
      refId: id,
      url: liveItem?.url || ref.url,
    });
    // Немає даних — питаємо сайт. Але питаємо і тоді, коли фіди дають OUT:
    // «out of stock» у Google означає і «немає», і «під замовлення», а знімати
    // з продажу позицію, яку ще можна замовити, — втрачені гроші замовниці.
    if (!known || resolveState(liveItem, known, inStock) === STATE.OUT) urls.add(ref.url);
  }

  const seen = new Set(
    Object.entries(reference.offers).flatMap(([id, ref]) => {
      const item = live.byUrlId.get(id) ?? live.byUrl.get(normUrl(ref.url));
      return item ? [item] : [];
    }),
  );
  for (const item of live.offers) {
    if (seen.has(item)) continue;
    const { known } = lookupStock(stock, { articleId: item.id, refId: urlId(item.url), url: item.url });
    if (!known) urls.add(item.url);
  }

  return [...urls];
}

// Детермінований group_id для товарів, яких ще немає серед карток Rozetka:
// той самий артикул завжди дає те саме число, незалежно від порядку у фіді.
// Діапазон 900000+ не перетинається з наявними групами еталона (максимум ~665000).
export function syntheticGroupId(base) {
  let h = 0;
  const s = String(base).toLowerCase();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(900000 + (h % 99000));
}

const PREORDER_PARAMS = ['Кнопка передзамовлення', 'Термін доставки'];
const withoutPreorder = (params) => params.filter((p) => !PREORDER_PARAMS.includes(p.name));

function renderOffer(o) {
  const attrs = ['id="' + esc(o.id) + '"'];
  if (o.groupId) attrs.push('group_id="' + esc(o.groupId) + '"');
  attrs.push('available="' + o.available + '"');

  const rows = ['  <offer ' + attrs.join(' ') + '>'];
  rows.push('   <url>' + esc(o.url) + '</url>');
  if (o.price) rows.push('   <price>' + esc(o.price) + '</price>');
  if (o.oldprice) rows.push('   <oldprice>' + esc(o.oldprice) + '</oldprice>');
  rows.push('   <currencyId>' + esc(o.currencyId || 'UAH') + '</currencyId>');
  rows.push('   <categoryId>' + esc(o.categoryId) + '</categoryId>');
  for (const p of o.pictures) rows.push('   <picture>' + esc(p) + '</picture>');
  if (o.vendorCode) rows.push('   <vendorCode>' + esc(o.vendorCode) + '</vendorCode>');
  if (o.vendor) rows.push('   <vendor>' + esc(o.vendor) + '</vendor>');
  // Облік залишків у Хорошопі вимкнений, кількостей у системі немає — повторюємо
  // умовне число, яке шле сам Хорошоп, щоб не показувати вигадані «100 шт.».
  rows.push('   <stock_quantity>' + (o.available === 'true' ? 999 : 0) + '</stock_quantity>');
  if (o.name) rows.push('   <name>' + cdata(o.name) + '</name>');
  if (o.nameUa) rows.push('   <name_ua>' + cdata(o.nameUa) + '</name_ua>');
  if (o.description) rows.push('   <description>' + cdata(o.description) + '</description>');
  if (o.descriptionUa) rows.push('   <description_ua>' + cdata(o.descriptionUa) + '</description_ua>');
  for (const p of o.params) {
    if (!p.name || p.value === '') continue;
    rows.push('   <param name="' + esc(p.name) + '">' + esc(p.value) + '</param>');
  }
  rows.push('  </offer>');
  return rows.join('\n');
}

// Нижче цих порогів джерело вважається зіпсованим. Числа взяті з фактичних обсягів
// (живий фід 525, джерело наявності 446) із запасом на природні коливання каталогу.
export const MIN_LIVE = 300;
export const MIN_STOCK = 250;

export function buildFeed({ reference, live, stock, now, siteStatus }) {
  // Порожнє чи обрізане джерело зняло б наявність з усього каталогу — краще віддати помилку.
  if (!live.count) throw new Error('живий фід Хорошопа порожній — фід не оновлюємо');
  if (live.count < MIN_LIVE) {
    throw new Error(`живий фід підозріло малий: ${live.count} позицій, очікуємо від ${MIN_LIVE}`);
  }
  // Без джерела наявності всі активні товари пішли б як «в наявності» — тиха деградація,
  // яку помітно лише за скасованими замовленнями.
  if (!stock.count) throw new Error('джерело наявності порожнє — фід не оновлюємо');
  if (stock.count < MIN_STOCK) {
    throw new Error(`джерело наявності підозріло мале: ${stock.count} позицій, очікуємо від ${MIN_STOCK}`);
  }

  const stats = {
    total: 0, inStock: 0, preorder: 0, out: 0, kept: 0, fresh: 0, fromSite: 0,
    matchedUrlId: 0, matchedUrl: 0, unmatchedReference: 0,
  };
  const usedLive = new Set();
  const parts = [];

  for (const [id, ref] of Object.entries(reference.offers)) {
    let liveItem = live.byUrlId.get(id);
    if (liveItem) stats.matchedUrlId++;
    else {
      liveItem = live.byUrl.get(normUrl(ref.url));
      if (liveItem) stats.matchedUrl++;
      else stats.unmatchedReference++;
    }
    if (liveItem) usedLive.add(liveItem);

    const { known, inStock } = lookupStock(stock, {
      articleId: liveItem?.id ?? null,
      refId: id,
      url: liveItem?.url || ref.url,
    });
    const fromSite = lookupSite(siteStatus, ref.url);
    let state = fromSite ?? resolveState(liveItem, known, inStock);
    if (fromSite) stats.fromSite++;
    if (state === STATE.KEEP) {
      // Жодне джерело не знає товар — лишаємо стан зі знімка, щоб не зняти живу позицію.
      // Параметри віддаємо як є: вирізати передзамовлення тут означало б мовчки
      // перетворити «Передзамовити» на «Купити».
      stats.kept++;
      state = ref.available ? STATE.IN_STOCK : STATE.OUT;
      const params = ref.params;
      stats.total++;
      if (state === STATE.IN_STOCK) stats.inStock++; else stats.out++;
      parts.push(renderOffer({
        id,
        groupId: ref.groupId,
        available: state === STATE.OUT ? 'false' : 'true',
        url: ref.url,
        price: ref.price,
        oldprice: ref.oldprice,
        currencyId: ref.currencyId,
        categoryId: ref.categoryId,
        pictures: ref.pictures,
        vendorCode: ref.vendorCode,
        vendor: ref.vendor,
        name: ref.name,
        nameUa: ref.nameUa,
        description: ref.description,
        descriptionUa: ref.descriptionUa,
        params,
      }));
      continue;
    }

    const params = withoutPreorder(ref.params);
    if (state === STATE.PREORDER) {
      // Так само Хорошоп передає передзамовлення — механізм на Rozetka вже робочий.
      params.push({ name: 'Кнопка передзамовлення', value: 'Передзамовити' });
      params.push({ name: 'Термін доставки', value: '12' });
      stats.preorder++;
    } else if (state === STATE.IN_STOCK) stats.inStock++;
    else stats.out++;

    stats.total++;
    parts.push(renderOffer({
      id,
      groupId: ref.groupId,
      available: state === STATE.OUT ? 'false' : 'true',
      url: liveItem?.url || ref.url,
      price: liveItem?.price || ref.price,
      // Стару ціну беремо лише з живого джерела: якщо акція скінчилась, Хорошоп
      // перестає слати price_old, а знімок від 17.06 показав би фіктивну знижку.
      oldprice: liveItem ? liveItem.priceOld : null,
      currencyId: ref.currencyId,
      categoryId: ref.categoryId,
      pictures: ref.pictures.length ? ref.pictures : liveItem?.pictures ?? [],
      vendorCode: ref.vendorCode,
      vendor: ref.vendor,
      name: ref.name,
      nameUa: ref.nameUa,
      description: ref.description,
      descriptionUa: ref.descriptionUa,
      params,
    }));
  }

  // Нові товари з сайту, яких ще немає серед карток Rozetka.
  const groupByBase = new Map();
  const vendors = new Map();
  for (const o of Object.values(reference.offers)) {
    if (o.vendorCode && o.groupId) groupByBase.set(o.vendorCode.toLowerCase(), o.groupId);
    if (o.vendor) vendors.set(o.vendor, (vendors.get(o.vendor) || 0) + 1);
  }
  const defaultVendor = [...vendors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Характеристики, які Rozetka вимагає для жіночого одягу. У живому фіді їх немає,
  // тому беремо ті самі значення, що стоять у всіх 612 карток еталона.
  const commonParams = new Map();
  for (const o of Object.values(reference.offers)) {
    for (const p of o.params) {
      if (p.name === 'Бренд' || p.name === 'Країна-виробник') {
        if (!commonParams.has(p.name)) commonParams.set(p.name, p.value);
      }
    }
  }

  for (const item of live.offers) {
    if (usedLive.has(item)) continue;
    const { known, inStock } = lookupStock(stock, { articleId: item.id, refId: urlId(item.url), url: item.url });
    const state = lookupSite(siteStatus, item.url) ?? resolveState(item, known, inStock);
    if (state === STATE.OUT || state === STATE.KEEP) continue;

    const { base, size } = splitArticle(item.id);
    const params = withoutPreorder(item.params);
    if (size && !params.some((p) => p.name === 'Розмір')) params.push({ name: 'Розмір', value: size });
    if (state === STATE.PREORDER) {
      params.push({ name: 'Кнопка передзамовлення', value: 'Передзамовити' });
      params.push({ name: 'Термін доставки', value: '12' });
      stats.preorder++;
    } else stats.inStock++;

    for (const [name, value] of commonParams) {
      if (!params.some((p) => p.name === name)) params.push({ name, value });
    }

    // Група має бути стабільною між запусками: лічильник дав би товару новий group_id
    // при будь-якій перестановці у фіді, а Rozetka на це розформовує групу розмірів.
    let groupId = groupByBase.get(base.toLowerCase());
    if (!groupId) {
      groupId = syntheticGroupId(base);
      groupByBase.set(base.toLowerCase(), groupId);
    }

    stats.total++;
    stats.fresh++;
    parts.push(renderOffer({
      id: urlId(item.url) || item.id,
      groupId,
      available: 'true',
      url: item.url,
      price: item.price,
      oldprice: item.priceOld,
      currencyId: 'UAH',
      categoryId: pickCategory(item.name, reference.categories),
      pictures: item.pictures,
      vendorCode: base,
      vendor: defaultVendor,
      name: item.name,
      nameUa: item.name,
      description: item.description,
      descriptionUa: item.description,
      params,
    }));
  }

  const cats = reference.categories
    .map((c) => '   <category id="' + esc(c.id) + '"' +
      (c.parentId ? ' parentId="' + esc(c.parentId) + '"' : '') +
      (c.rzId ? ' rz_id="' + esc(c.rzId) + '"' : '') +
      '>' + esc(c.name) + '</category>')
    .join('\n');

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE yml_catalog SYSTEM "shops.dtd">\n' +
    '<yml_catalog date="' + now + '">\n' +
    ' <shop>\n' +
    '  <name>' + esc(reference.shop.name) + '</name>\n' +
    '  <company>' + esc(reference.shop.company) + '</company>\n' +
    '  <url>' + esc(reference.shop.url) + '</url>\n' +
    '  <currencies>\n   <currency id="UAH" rate="1"/>\n  </currencies>\n' +
    '  <categories>\n' + cats + '\n  </categories>\n' +
    '  <offers>\n' + parts.join('\n') + '\n  </offers>\n' +
    ' </shop>\n' +
    '</yml_catalog>';

  return { xml, stats };
}
