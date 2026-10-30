// 네이버 검색광고(파워링크) 크롤러.
// 네이버는 광고 라이브러리가 없어서, 광고주 키워드로 '파워링크 더보기' 페이지를 검색해 해당 광고주 광고를 찾는다.
// 광고 클릭 URL(ader.naver.com)은 과금되므로 절대 호출하지 않고, 페이지에 노출된 표시 URL만 쓴다.
const cheerio = require('cheerio');
const { UA_DESKTOP, nameMatches, domainMatches, hostOf, fetchWithTimeout, sleep } = require('../util');

function parsePage(html, keyword) {
  const $ = cheerio.load(html);
  const ads = [];
  $('ol.lst_type > li.lst, ul.lst_type > li.lst').each((_, li) => {
    const el = $(li);
    const site = el.find('a.site').first().text().trim();
    const displayUrl = el.find('a.url').first().text().trim();
    const title = el.find('.lnk_tit').first().text().replace(/\s+/g, ' ').trim();
    const desc = el.find('.desc_area, .desc').first().text().replace(/\s+/g, ' ').trim();
    const urls = new Set();
    const html = $.html(li);
    for (const m of html.matchAll(/d=["']\s*\+\s*urlencode\(["']([^"']+)["']\)/g)) urls.add(m[1].replace(/&amp;/g, '&'));
    let adId = '';
    const idm = html.match(/nad-a\d+-\d+-\d+/);
    if (idm) adId = idm[0];
    if (!urls.size && displayUrl) urls.add('https://' + displayUrl.replace(/^https?:\/\//, ''));
    ads.push({
      platform: 'naver',
      adId: adId || `${site}|${displayUrl}|${title}`,
      advertiser: site,
      displayUrl,
      keyword,
      active: true,
      title: title.slice(0, 120),
      text: [title, desc].join('\n').slice(0, 1000),
      landingUrls: [...urls].filter(u => /^https?:\/\//.test(u)),
      utmNotApplicable: true,
      adUrl: `https://ad.search.naver.com/search.naver?where=ad&query=${encodeURIComponent(keyword)}`,
    });
  });
  return ads;
}

async function crawlNaver(advertiser, { maxPages = 3, log = () => {} } = {}) {
  const names = [advertiser.name, ...(advertiser.aliases || [])];
  const domains = advertiser.domains || [];
  const keywords = advertiser.naverKeywords?.length ? advertiser.naverKeywords : [advertiser.name];
  const byId = new Map();
  let total = 0;

  for (const kw of keywords) {
    for (let p = 1; p <= maxPages; p++) {
      const url = `https://ad.search.naver.com/search.naver?where=ad&query=${encodeURIComponent(kw)}&pagingIndex=${p}`;
      const r = await fetchWithTimeout(url, { headers: { 'user-agent': UA_DESKTOP, 'accept-language': 'ko-KR,ko;q=0.9' } });
      if (!r.ok) throw new Error(`Naver HTTP ${r.status}`);
      const ads = parsePage(await r.text(), kw);
      total += ads.length;
      for (const ad of ads) {
        // 도메인을 지정했으면 도메인 일치만 본다 (이름만 비슷한 다른 회사 광고 방지)
        const mine = domains.length
          ? domainMatches('https://' + ad.displayUrl, domains) || ad.landingUrls.some(u => domainMatches(u, domains))
          : nameMatches(ad.advertiser, names);
        if (mine && !byId.has(ad.adId)) byId.set(ad.adId, ad);
      }
      if (ads.length < 25) break;
      await sleep(800);
    }
  }
  const ads = [...byId.values()];
  log(`Naver: 키워드 ${keywords.length}개, 파워링크 ${total}건 중 광고주 일치 ${ads.length}건`
    + (ads.length ? ` (${[...new Set(ads.map(a => hostOf(a.landingUrls[0] || '')))].join(', ')})` : ''));
  return ads;
}

module.exports = { crawlNaver, parsePage };
