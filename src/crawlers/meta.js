// Meta 광고 라이브러리 크롤러 (로그인/API 없이 공개 페이지를 헤드리스 브라우저로 연다)
const crypto = require('crypto');
const { withPage } = require('../browser');
const { nameMatches, sleep } = require('../util');

function unwrapFbLink(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (/(^|\.)l\.facebook\.com$|(^|\.)lm\.facebook\.com$/.test(url.hostname) && url.searchParams.get('u')) {
      return url.searchParams.get('u');
    }
  } catch { return null; }
  return u;
}

// JSON 트리에서 ad_archive_id + snapshot 을 가진 객체를 모두 찾는다
function collectAds(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) collectAds(x, out); return; }
  if (node.ad_archive_id && node.snapshot) { out.push(node); return; }
  for (const k in node) collectAds(node[k], out);
}

function parseJsonBlobs(text) {
  const out = [];
  const re = /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(text))) {
    if (!m[1].includes('ad_archive_id')) continue;
    try { out.push(JSON.parse(m[1])); } catch {}
  }
  return out;
}

function parseGraphql(text) {
  const out = [];
  // 응답이 여러 줄의 JSON 으로 오는 경우가 있다
  for (const line of text.split('\n')) {
    const s = line.replace(/^for \(;;\);/, '').trim();
    if (!s.startsWith('{') || !s.includes('ad_archive_id')) continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}

const PAGINATION_NAME = 'AdLibrarySearchPaginationQuery';
// 광고 라이브러리 웹앱의 검색 페이지네이션 쿼리 ID (바뀌면 META_PAGINATION_DOC_ID 로 덮어쓰기)
const PAGINATION_DOC_ID = '24922295957467452';

// 광고주 페이지 화면을 여는 조건 조합 (게재 시작일 구간 × 소재 유형 × 정렬). 각 조합의 첫 화면이 서로 다른 소재를 보여 준다
const MEDIA = ['all', 'image', 'video'];
const SORTS = ['', '&sort_data[mode]=total_impressions&sort_data[direction]=asc'];
function pageVariants(now = new Date()) {
  const d = days => new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10);
  const windows = [
    '',
    `&start_date[min]=${d(7)}`,
    `&start_date[min]=${d(30)}&start_date[max]=${d(8)}`,
    `&start_date[min]=${d(90)}&start_date[max]=${d(31)}`,
    `&start_date[max]=${d(91)}`,
  ];
  return windows.flatMap(w => SORTS.flatMap(s => MEDIA.map(m => `&media_type=${m}${s}${w}`)));
}

// 검색 결과 연결의 다음 페이지 커서
function findPageInfo(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const x of node) { const r = findPageInfo(x); if (r) return r; }
    return null;
  }
  if (node.search_results_connection?.page_info) return node.search_results_connection.page_info;
  for (const k in node) { const r = findPageInfo(node[k]); if (r) return r; }
  return null;
}

function toAd(raw) {
  const s = raw.snapshot || {};
  const urls = new Set();
  const push = u => { const x = unwrapFbLink(u); if (x && /^https?:/.test(x)) urls.add(x); };
  push(s.link_url);
  for (const c of s.cards || []) push(c.link_url);
  const body = typeof s.body === 'object' ? s.body?.text : s.body;
  const texts = [body, s.title, s.link_description, s.caption, ...(s.cards || []).flatMap(c => [c.body, c.title, c.link_description])]
    .filter(t => typeof t === 'string');
  return {
    platform: 'meta',
    adId: String(raw.ad_archive_id),
    advertiser: s.page_name || raw.page_name || '',
    pageId: String(s.page_id || raw.page_id || ''),
    active: raw.is_active !== false,
    title: (s.title || (s.cards && s.cards[0]?.title) || '').slice(0, 120),
    text: texts.join('\n').slice(0, 2000),
    landingUrls: [...urls],
    adUrl: `https://www.facebook.com/ads/library/?id=${raw.ad_archive_id}`,
  };
}

async function crawlMeta(advertiser, { maxAds = 150, log = () => {} } = {}) {
  const names = [advertiser.name, ...(advertiser.aliases || [])];
  const q = advertiser.metaQuery || advertiser.name;
  const url = 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=KR'
    + `&q=${encodeURIComponent(q)}&search_type=keyword_unordered&media_type=all`;

  return withPage(async page => {
    const blobs = [];
    let template = null; // 브라우저가 실제로 보낸 페이지네이션 요청 본문 (있으면 그대로 재사용)
    page.on('request', r => {
      if (!template && r.url().includes('/api/graphql') && (r.postData() || '').includes(PAGINATION_NAME)) template = r.postData();
    });
    page.on('response', async r => {
      if (!r.url().includes('/api/graphql')) return;
      try { blobs.push(...parseGraphql(await r.text())); } catch {}
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    const html = await page.content();
    blobs.push(...parseJsonBlobs(html));
    const count = () => { const f = []; collectAds(blobs, f); return new Set(f.map(a => a.ad_archive_id)).size; };
    const first = count();

    // 스크롤 대신 페이지네이션 요청을 직접 호출한다.
    // (서버의 헤드리스 환경에서는 스크롤로 추가 로드가 안 일어나는 경우가 많다)
    let cursor = findPageInfo(blobs);
    // 페이지가 실제 요청에 붙이는 공통 파라미터(lsd, __dyn, __rev 등)를 페이지 모듈에서 그대로 가져온다
    const common = await page.evaluate(() => {
      try { return { ...window.require('getAsyncParams')('POST') }; } catch {}
      try { return { lsd: window.require('LSD').token, __a: '1', __user: '0' }; } catch {}
      return null;
    }).catch(() => null);
    const lsd = common?.lsd;
    const baseVars = {
      activeStatus: 'active', adType: 'ALL', bylines: [], collationToken: null, contentLanguages: [], countries: ['KR'],
      excludedIDs: null, first: 30, isTargetedCountry: false, location: null, mediaType: 'all', multiCountryFilterMode: null,
      pageIDs: [], potentialReachInput: null, publisherPlatforms: [], queryString: q, regions: null, searchType: 'keyword_unordered',
      sessionID: crypto.randomUUID(), sortData: null, source: null, startDate: null, viewAllPageID: '0',
    };
    let pages = 0;
    let paginationBlocked = !!process.env.META_NO_PAGINATION;
    while (!paginationBlocked && cursor?.has_next_page && cursor.end_cursor && count() < maxAds * 2 && pages < 20) {
      pages++;
      let body;
      if (template) {
        const p = new URLSearchParams(template);
        const v = JSON.parse(p.get('variables'));
        p.set('variables', JSON.stringify({ ...v, cursor: cursor.end_cursor, first: 30 }));
        body = p.toString();
      } else {
        if (!lsd) break;
        body = new URLSearchParams({
          av: '0', __user: '0', __a: '1', __comet_req: '1', ...common, server_timestamps: 'true',
          fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: PAGINATION_NAME,
          variables: JSON.stringify({ ...baseVars, cursor: cursor.end_cursor }),
          doc_id: process.env.META_PAGINATION_DOC_ID || PAGINATION_DOC_ID,
        }).toString();
      }
      // 요청 제한(Rate limit)에 걸리면 15초 기다렸다 한 번 더 시도 (안 되면 아래의 '조건별 첫 화면' 방식으로 전환)
      let text = '';
      for (const wait of [0, 15000]) {
        if (wait) { log(`Meta: 요청 제한 — ${wait / 1000}초 후 재시도`); await sleep(wait); }
        text = await page.evaluate(async ({ body, lsd }) => {
          const r = await fetch('/api/graphql/', {
            method: 'POST', credentials: 'include', body,
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-lsd': lsd || '', 'x-fb-friendly-name': 'AdLibrarySearchPaginationQuery' },
          });
          return r.text();
        }, { body, lsd }).catch(() => '');
        if (!/Rate limit|1675004/i.test(text)) break;
      }
      const parsed = parseGraphql(text);
      if (!parsed.length) {
        log(`Meta: 추가 페이지 요청 실패 (${pages}번째) — ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
        paginationBlocked = true;
        break;
      }
      blobs.push(...parsed);
      cursor = findPageInfo(parsed);
      await sleep(600);
    }
    if (pages) log(`Meta: 첫 화면 ${first}건 + 추가 ${pages}페이지 → ${count()}건`);

    // 데이터센터 IP(GitHub Actions·클라우드)는 '다음 페이지' 요청이 막힌다.
    // 첫 화면 결과는 막히지 않으므로, 광고주 페이지 전용 화면을 소재 유형·정렬 조건별로 열어 첫 화면을 모은다.
    if (paginationBlocked && cursor?.has_next_page) {
      const raws0 = [];
      collectAds(blobs, raws0);
      const pageIds = advertiser.metaPageIds?.length
        ? advertiser.metaPageIds
        : [...new Set(raws0.map(toAd).filter(a => nameMatches(a.advertiser, names)).map(a => a.pageId).filter(Boolean))];
      const before = count();
      let loads = 0;
      for (const pid of pageIds.slice(0, 3)) {
        let idle = 0;
        for (const v of pageVariants()) {
          if (count() >= maxAds * 2 || idle >= 8) break;
          const prev = count();
          const vurl = 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=KR&is_targeted_country=false'
            + `&search_type=page&view_all_page_id=${pid}${v}`;
          try {
            await page.goto(vurl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await sleep(3500);
            blobs.push(...parseJsonBlobs(await page.content()));
          } catch {}
          loads++;
          idle = count() > prev ? 0 : idle + 1;
        }
      }
      log(`Meta: 다음 페이지 요청이 막혀 광고주 페이지(${pageIds.length}개)를 조건별로 ${loads}번 조회 → ${before}건에서 ${count()}건`);
    }

    const raws = [];
    collectAds(blobs, raws);
    const seen = new Set();
    const ads = [];
    for (const r of raws) {
      const ad = toAd(r);
      if (seen.has(ad.adId)) continue;
      seen.add(ad.adId);
      if (!ad.active) continue;
      if (advertiser.metaPageIds?.length) {
        if (!advertiser.metaPageIds.includes(ad.pageId)) continue;
      } else if (!nameMatches(ad.advertiser, names)) continue;
      ads.push(ad);
      if (ads.length >= maxAds) break;
    }
    log(`Meta: 검색결과 ${seen.size}건 중 광고주 일치 ${ads.length}건`);
    return ads;
  });
}

module.exports = { crawlMeta, unwrapFbLink };
