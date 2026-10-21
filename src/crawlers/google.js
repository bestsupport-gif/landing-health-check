// Google 광고 투명성 센터 크롤러 (공개 웹앱이 쓰는 내부 RPC 를 그대로 호출)
const { UA_DESKTOP, norm, pool, fetchWithTimeout } = require('../util');

const BASE = 'https://adstransparency.google.com/anji/_/rpc/';
const REGION_KR = 2410;
const FORMAT = { 1: '텍스트', 2: '이미지', 3: '동영상' };

async function rpc(svc, req) {
  const r = await fetchWithTimeout(`${BASE}${svc}?authuser=0`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA_DESKTOP },
    body: 'f.req=' + encodeURIComponent(JSON.stringify(req)),
  });
  if (!r.ok) throw new Error(`Google RPC ${svc} HTTP ${r.status}`);
  return JSON.parse(await r.text());
}

async function findAdvertisers(query) {
  const j = await rpc('SearchService/SearchSuggestions', { 1: query, 2: 10, 3: 10 });
  return (j['1'] || []).map(x => x['1']).filter(Boolean).map(x => ({ name: x['1'], id: x['2'], country: x['3'] }));
}

function decodeJs(t) {
  return t
    .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([\/=&?])/g, '$1');
}

// 미리보기 스크립트에서 adurl / destination_url 을 꺼낸다. 클릭 URL 은 호출하지 않는다(과금 방지).
function extractLanding(js) {
  const t = decodeJs(js);
  const urls = new Set();
  for (const m of t.matchAll(/[?&]adurl=([^'"\s&]+)/g)) {
    try { const u = decodeURIComponent(m[1]); if (/^https?:\/\//.test(u)) urls.add(u); } catch {}
  }
  for (const m of t.matchAll(/destination_url\s*:\s*'([^']+)'/g)) {
    try { const u = decodeURIComponent(m[1]); if (/^https?:\/\//.test(u)) urls.add(u); } catch {}
  }
  const vis = t.match(/visible_url\s*:\s*'([^']*)'/);
  const texts = [];
  for (const m of t.matchAll(/(?:headline|description|title|long_headline)\s*:\s*'([^']{2,200})'/g)) texts.push(m[1]);
  return { urls: [...urls], visibleUrl: vis ? vis[1] : '', text: texts.join('\n') };
}


async function searchCreatives(filter, maxAds) {
  const out = [];
  let token = null;
  for (let page = 0; page < 5 && out.length < maxAds; page++) {
    const req = { 2: 100, 3: { 12: { 1: '', 2: true }, ...filter, 8: [REGION_KR] }, 7: { 1: 1, 2: 30, 3: REGION_KR } };
    if (token) req[4] = token;
    const j = await rpc('SearchService/SearchCreatives', req);
    out.push(...(j['1'] || []));
    token = j['2'];
    if (!token) break;
  }
  return out;
}

const hostOnly = d => String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\.|^m\./, '').split('/')[0];

// 소재 수집 경로 2가지를 합친다
//  1) 광고주 도메인으로 검색 — 법인명이 브랜드명과 달라도 됨 (예: 헤라 → hera.com → (주)아모레퍼시픽 소재)
//  2) 광고주명(또는 Google 법인명) 정확 일치 광고주 ID
async function crawlGoogle(advertiser, { maxAds = 150, log = () => {} } = {}) {
  const creatives = new Map();
  const add = list => list.forEach(c => { if (!creatives.has(c['2'])) creatives.set(c['2'], c); });

  const domains = [...new Set((advertiser.domains || []).map(hostOnly).filter(d => d.includes('.') && !/naver\.com$|kakao\.com$|instagram\.com$|facebook\.com$/.test(d)))];
  for (const d of domains) {
    const list = await searchCreatives({ 12: { 1: d, 2: true } }, maxAds);
    log(`Google: 도메인 ${d} 소재 ${list.length}건`);
    add(list);
  }

  let ids = advertiser.googleAdvertiserIds || [];
  if (!ids.length) {
    const names = [advertiser.googleQuery, advertiser.name, ...(advertiser.aliases || [])].filter(Boolean);
    const found = [];
    for (const n of names) found.push(...await findAdvertisers(n));
    // 정확 일치만 사용 (부분 일치는 '헤라' → '헤라주' 같은 오탐이 생김)
    const picked = found.filter(a => (!a.country || a.country === 'KR') && names.some(n => norm(n) === norm(a.name)));
    ids = [...new Set(picked.map(a => a.id))];
    if (ids.length) log(`Google: 광고주명 일치 ID ${ids.length}개 (${[...new Set(picked.map(a => a.name))].join(', ')})`);
  }
  if (ids.length) add(await searchCreatives({ 13: { 1: ids } }, maxAds));

  if (!creatives.size) {
    log('Google: 소재를 찾지 못함 — 광고주 도메인 또는 Google 법인명을 설정하세요');
    return [];
  }

  const list = [...creatives.values()].slice(0, maxAds);
  const ads = await pool(list, 6, async c => {
    const previewUrl = c['3']?.['1']?.['4'];
    let info = { urls: [], visibleUrl: '', text: '' };
    if (previewUrl) {
      try {
        const r = await fetchWithTimeout(previewUrl, { headers: { 'user-agent': UA_DESKTOP } });
        info = extractLanding(await r.text());
      } catch {}
    }
    return {
      platform: 'google',
      adId: c['2'],
      advertiser: c['12'] || '',
      active: true,
      format: FORMAT[c['4']] || String(c['4']),
      title: info.text.split('\n')[0]?.slice(0, 120) || `${FORMAT[c['4']] || ''} 소재`,
      text: info.text.slice(0, 2000),
      visibleUrl: info.visibleUrl,
      landingUrls: info.urls,
      adUrl: `https://adstransparency.google.com/advertiser/${c['1']}/creative/${c['2']}?region=KR`,
    };
  });
  log(`Google: 소재 ${ads.length}건, 랜딩 URL 확인 ${ads.filter(a => a.landingUrls.length).length}건`);
  return ads;
}

module.exports = { crawlGoogle, findAdvertisers, extractLanding };