// Meta 광고 라이브러리 크롤러 (로그인/API 없이 공개 페이지를 헤드리스 브라우저로 연다)
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
    page.on('response', async r => {
      if (!r.url().includes('/api/graphql')) return;
      try { blobs.push(...parseGraphql(await r.text())); } catch {}
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    blobs.push(...parseJsonBlobs(await page.content()));

    // 스크롤하며 추가 결과 로드
    let last = -1;
    for (let i = 0; i < 12; i++) {
      const found = [];
      collectAds(blobs, found);
      if (found.length >= maxAds * 2 || found.length === last) break;
      last = found.length;
      await page.mouse.wheel(0, 20000);
      await sleep(2500);
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
