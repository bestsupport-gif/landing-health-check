// 랜딩 페이지 1건을 열어 상태코드 / 품절 / 가격 / 소프트404 / 메인 리다이렉트를 판정한다
const cheerio = require('cheerio');
const { UA_MOBILE, fetchWithTimeout } = require('./util');
const { withPage } = require('./browser');

const SOLD_RE = /^(일시\s*)?품절(\s*상품)?$|^sold\s*-?\s*out$|^out\s*of\s*stock$|^재고\s*없음$|^재입고\s*알림(\s*신청)?$|^입고\s*알림(\s*신청)?$|^판매\s*종료$/i;
const BUY_RE = /^(바로\s*)?구매(하기)?$|^바로\s*구매$|^장바구니(\s*담기)?$|^buy\s*now$|^add\s*to\s*cart$|^주문하기$|^구매하기$/i;
const SOFT404_RE = /페이지를\s*찾을\s*수\s*없|존재하지\s*않는\s*(상품|페이지)|삭제된\s*상품|판매가?\s*(종료|중지|중단)된|판매하지\s*않는\s*상품|상품\s*정보가\s*없|잘못된\s*(접근|경로)|page\s*not\s*found|404\s*not\s*found/i;
const HIDDEN_CLASS_RE = /(^|\s)(displaynone|display-none|hide|hidden|blind|sr-only|screen_out|ir|d-none|is-hidden)(\s|$)/i;
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|gbraid|wbraid|n_|nt_|NaPm|af_|pid$|c$|is_retargeting|deep_link|ets_|_ga|mc_)/i;

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign'];

// 랜딩 유형: 상품 상세(직랜딩) vs 기획전/카테고리/목록(여러 상품)
const PRODUCT_URL_RE = /goodsview|getgoodsdetail|goods_?detail|\/goods\/\d|[?&]goodsno=|product_no=|\/products?\/[\w-]+|\/product\/detail|detail\.html|\/item\/|\/itemview|\/vp\/products|\/catalog\/\d|[?&](itemid|prdno|productid|goodscode|goods_cd)=/i;
const LISTING_URL_RE = /planshop|plan\/|exhibition|exhibit|event|promotion|promo|campaign|special|category|categories|collection|\/list|search|brand\/|brandshop|\/display\/|\/theme|benefit|sale\b|기획전|이벤트/i;
const PRODUCT_LINK_RE = /goodsview|getgoodsdetail|goods_?detail|goodsno=|product_no=|\/products?\/|detail\.html|\/item\//i;

function classifyPage($, url, ldTypes) {
  const isProductUrl = PRODUCT_URL_RE.test(url);
  const isListingUrl = LISTING_URL_RE.test(url) && !isProductUrl;
  const ogType = ($('meta[property="og:type"]').attr('content') || '').toLowerCase();
  // 서로 다른 상품 상세로 가는 링크 수 (목록/기획전이면 많다)
  const links = new Set();
  $('a[href]').each((_, a) => {
    const h = $(a).attr('href') || '';
    if (PRODUCT_LINK_RE.test(h)) links.add(h.replace(/[#].*$/, '').replace(/&(utm_|t_|trk|dispcatno|rccode)[^&]*/gi, ''));
  });
  const productLinks = links.size;
  if (isListingUrl) return { type: 'listing', productLinks };
  if (isProductUrl || ogType.includes('product') || ldTypes.includes('product')) return { type: 'product', productLinks };
  if (ldTypes.includes('itemlist') || productLinks >= 8) return { type: 'listing', productLinks };
  return { type: 'other', productLinks };
}

function urlKey(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) url.searchParams.delete(k);
    url.hostname = url.hostname.replace(/^(www|m)\./, '');
    return url.toString();
  } catch { return u; }
}

function missingUtm(...urls) {
  let best = UTM_KEYS;
  for (const u of urls) {
    if (!u) continue;
    try {
      const p = new URL(u).searchParams;
      const miss = UTM_KEYS.filter(k => !p.get(k));
      if (miss.length < best.length) best = miss;
    } catch {}
  }
  return best;
}

function isHidden($, el) {
  let cur = el;
  for (let i = 0; cur && cur.type === 'tag' && i < 8; i++) {
    const cls = $(cur).attr('class') || '';
    const style = ($(cur).attr('style') || '').replace(/\s/g, '').toLowerCase();
    if (HIDDEN_CLASS_RE.test(cls) || style.includes('display:none') || style.includes('visibility:hidden')) return true;
    if ($(cur).attr('hidden') !== undefined || $(cur).attr('aria-hidden') === 'true') return true;
    if (['select', 'option', 'template', 'noscript', 'script'].includes(cur.name)) return true;
    cur = cur.parent;
  }
  return false;
}

function ownText($, el) {
  return $(el).contents().filter((_, n) => n.type === 'text').text().replace(/\s+/g, ' ').trim()
    || ($(el).children().length === 0 ? $(el).text().replace(/\s+/g, ' ').trim() : '');
}

function walkJsonLd(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(n => walkJsonLd(n, out));
  if (node.offers) {
    const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
    for (const o of offers) {
      if (!o) continue;
      const p = Number(String(o.price ?? o.lowPrice ?? '').replace(/[^\d.]/g, ''));
      if (p) out.prices.push(p);
      if (o.availability) out.avail.push(String(o.availability));
      if (o.offers) walkJsonLd(o, out);
    }
  }
  for (const k in node) if (k !== 'offers' && typeof node[k] === 'object') walkJsonLd(node[k], out);
}

function analyzeHtml(html, finalUrl) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim().slice(0, 150);
  const signals = { soldStrong: [], soldText: [], buy: 0, prices: [], soft404: '' };

  // 1) 구조화 데이터 (JSON-LD)
  const ld = { prices: [], avail: [] };
  const ldTypes = [];
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const j = JSON.parse($(s).html());
      walkJsonLd(j, ld);
      for (const n of [j, ...(Array.isArray(j) ? j : []), ...(j['@graph'] || [])]) {
        if (n && n['@type']) ldTypes.push(...[].concat(n['@type']).map(t => String(t).toLowerCase()));
      }
    } catch {}
  });
  signals.prices.push(...ld.prices.map(p => ({ v: p, src: 'JSON-LD' })));
  if (ld.avail.length && ld.avail.every(a => /OutOfStock|SoldOut|Discontinued/i.test(a))) signals.soldStrong.push('JSON-LD availability=OutOfStock');

  // 2) 메타 태그
  const meta = n => $(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`).attr('content');
  const avail = meta('product:availability') || meta('og:availability') || meta('availability');
  if (avail && /out\s*of\s*stock|oos|sold\s*out|품절/i.test(avail)) signals.soldStrong.push(`meta availability=${avail}`);
  for (const n of ['product:sale_price:amount', 'eg:salePrice', 'product:price:amount', 'og:price:amount', 'price']) {
    const v = Number(String(meta(n) || '').replace(/[^\d.]/g, ''));
    if (v) signals.prices.push({ v, src: n });
  }

  // 3) 플랫폼별 패턴 (스마트스토어 / 카페24 등 인라인 상태값)
  const st = html.match(/"productStatusType"\s*:\s*"(OUTOFSTOCK|SUSPENSION|CLOSE|PROHIBITION)"/);
  if (st) signals.soldStrong.push(`productStatusType=${st[1]}`);
  if (/"stockQuantity"\s*:\s*0[,}]/.test(html) && /smartstore|brand\.naver/.test(finalUrl)) signals.soldStrong.push('stockQuantity=0');
  const ss = html.match(/"discountedSalePrice"\s*:\s*(\d+)/) || html.match(/"salePrice"\s*:\s*(\d+)/);
  if (ss) signals.prices.push({ v: Number(ss[1]), src: 'inline salePrice' });

  // 4) 화면 문구: 보이는 '품절' 버튼/라벨 vs 구매 버튼
  $('button, a, span, strong, em, p, div, input[type=button], input[type=submit]').each((_, el) => {
    const t = el.name === 'input' ? ($(el).attr('value') || '').trim() : ownText($, el);
    if (!t || t.length > 20) return;
    if (SOLD_RE.test(t)) { if (!isHidden($, el)) signals.soldText.push(t); }
    else if (BUY_RE.test(t)) {
      if (!isHidden($, el) && $(el).attr('disabled') === undefined && !/disable|soldout|sold_out/i.test($(el).attr('class') || '')) signals.buy++;
    }
  });

  // 5) 소프트 404: 제목/헤드라인/alert 문구
  const heads = [title, ...$('h1, h2, h3, .error, .alert, #error').slice(0, 15).map((_, e) => $(e).text().trim().slice(0, 120)).get()];
  const alerts = [...html.matchAll(/alert\(\s*['"]([^'"]{2,120})['"]\s*\)/g)].map(m => m[1]);
  const hit = [...heads, ...alerts].find(t => SOFT404_RE.test(t));
  if (hit) signals.soft404 = hit.slice(0, 80);

  const page = classifyPage($, finalUrl, ldTypes);
  return { title, signals, page, textLength: $('body').text().replace(/\s+/g, ' ').length };
}

async function fetchPage(url) {
  const r = await fetchWithTimeout(url, {
    redirect: 'follow',
    headers: { 'user-agent': UA_MOBILE, 'accept-language': 'ko-KR,ko;q=0.9', accept: 'text/html,application/xhtml+xml' },
  });
  const ct = r.headers.get('content-type') || '';
  const html = ct.includes('html') || ct === '' ? await r.text() : '';
  return { status: r.status, finalUrl: r.url || url, html, via: 'fetch' };
}

async function browserPage(url) {
  return withPage(async page => {
    let status = 0;
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => { throw e; });
    status = resp ? resp.status() : 0;
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    return { status, finalUrl: page.url(), html: await page.content(), via: 'browser' };
  }, { userAgent: UA_MOBILE, viewport: { width: 390, height: 844 } });
}

function pickPrice(prices) {
  // 판매가(할인가) 우선: 같은 출처 내에서는 가장 낮은 값
  const order = ['inline salePrice', 'product:sale_price:amount', 'eg:salePrice', 'JSON-LD', 'product:price:amount', 'og:price:amount', 'price'];
  for (const src of order) {
    const v = prices.filter(p => p.src === src && p.v >= 100).map(p => p.v);
    if (v.length) return Math.min(...v);
  }
  return null;
}

function isHomePath(u) {
  try {
    const p = new URL(u).pathname.replace(/\/(index|main)(\.\w+)?$/i, '/').replace(/\/+$/, '');
    return p === '' || /^\/(m|mobile|ko|kr)$/i.test(p);
  } catch { return false; }
}

/**
 * @returns {Promise<{url, finalUrl, httpStatus, via, title, price, issues: Array<{type, level, msg}>}>}
 */
async function checkUrl(url, { useBrowserFallback = true } = {}) {
  const issues = [];
  let res;
  try {
    res = await fetchPage(url);
  } catch (e) {
    res = { status: 0, finalUrl: url, html: '', via: 'fetch', error: e.name === 'AbortError' ? '시간 초과' : (e.cause?.code || e.message) };
  }

  const needsBrowser = useBrowserFallback && (
    [0, 403, 429, 503].includes(res.status) || (res.status < 400 && res.html.length < 3000)
  );
  if (needsBrowser) {
    try {
      const b = await browserPage(url);
      if (b.status) res = b;
    } catch (e) {
      if (!res.error) res.error = e.message.split('\n')[0];
    }
  }

  const out = { url, finalUrl: res.finalUrl, httpStatus: res.status, via: res.via, title: '', price: null, pageType: null, issues };

  if (res.status === 0) {
    issues.push({ type: 'error', level: 'critical', msg: `접속 실패 (${res.error || '응답 없음'})` });
    return out;
  }
  if (res.status === 404 || res.status === 410) {
    issues.push({ type: 'error', level: 'critical', msg: `HTTP ${res.status} 페이지 없음` });
    return out;
  }
  if (res.status >= 500) {
    issues.push({ type: 'error', level: 'critical', msg: `HTTP ${res.status} 서버 오류` });
    return out;
  }
  if (res.status >= 400) {
    issues.push({ type: 'blocked', level: 'info', msg: `HTTP ${res.status} (봇 차단 가능성, 수동 확인 필요)` });
    return out;
  }

  // 스마트스토어 등은 봇 접속을 로그인 페이지로 돌려보낸다 → 판정 불가
  if (/(^|\.)nid\.naver\.com$/.test(new URL(res.finalUrl).hostname) && !/nid\.naver\.com/.test(url)) {
    issues.push({ type: 'blocked', level: 'info', msg: '네이버 로그인 페이지로 이동 (스마트스토어 봇 차단, 수동 확인 필요)' });
    return out;
  }

  const a = analyzeHtml(res.html, res.finalUrl);
  out.title = a.title;
  out.pageType = a.page.type;

  if (a.signals.soft404) issues.push({ type: 'soft404', level: 'critical', msg: `페이지 없음/판매종료 문구: "${a.signals.soft404}"` });

  // 품절·가격은 상품 직랜딩에서만 판정한다.
  // 기획전/여러 상품 목록은 개별 상품 품절 표시가 섞여 있어 판정하지 않는다(점검 필요로 띄우지 않음).
  if (a.page.type === 'product') {
    out.price = pickPrice(a.signals.prices);
    const fix = ' — 랜딩 수정 필요 (대체 상품으로 교체 또는 소재 OFF)';
    if (a.signals.soldStrong.length) {
      issues.push({ type: 'soldout', level: 'critical', msg: `상품 직랜딩 품절 (${a.signals.soldStrong[0]})${fix}` });
    } else if (a.signals.soldText.length) {
      if (a.signals.buy === 0) issues.push({ type: 'soldout', level: 'critical', msg: `상품 직랜딩 품절 (화면 "${a.signals.soldText[0]}", 구매 버튼 없음)${fix}` });
      else issues.push({ type: 'soldout_suspect', level: 'warn', msg: '일부 옵션 품절 — 구매는 가능 (소재에 나온 컬러/호수가 품절인지 확인)' });
    }
  }

  if (!isHomePath(url) && isHomePath(res.finalUrl) && new URL(url).pathname.length > 12) {
    issues.push({ type: 'redirect_home', level: 'warn', msg: '메인 페이지로 리다이렉트됨 (상품 삭제/이벤트 종료 의심)' });
  }
  return out;
}

function adPrices(text) {
  const set = new Set();
  for (const m of String(text || '').matchAll(/(\d{1,3}(?:,\d{3})+|\d{4,7})\s*원/g)) {
    const v = Number(m[1].replace(/,/g, ''));
    if (v >= 1000) set.add(v);
  }
  return [...set];
}

module.exports = { checkUrl, analyzeHtml, missingUtm, urlKey, adPrices };
