const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

// 광고주명 비교용: 공백/괄호/(주) 제거, 소문자
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(주\)|㈜|주식회사|\(유\)|inc\.?|corp\.?|co\.,?\s*ltd\.?/g, '')
    .replace(/[\s()（）\[\]_\-.,·]/g, '');
}

function nameMatches(candidate, names) {
  const c = norm(candidate);
  if (!c) return false;
  return names.some(n => {
    const x = norm(n);
    return x && (c.includes(x) || x.includes(c));
  });
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\.|^m\./, ''); } catch { return ''; }
}

// domains 항목에 경로가 있으면(예: brand.naver.com/hera) 경로 앞부분까지 비교한다
function domainMatches(url, domains) {
  const h = hostOf(url);
  if (!h) return false;
  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); } catch {}
  return domains.some(d => {
    const x = String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\.|^m\./, '');
    const [host, ...rest] = x.split('/');
    const p = rest.length ? '/' + rest.join('/').replace(/\/+$/, '') : '';
    if (!host || !(h === host || h.endsWith('.' + host))) return false;
    return !p || path === p || path.startsWith(p + '/');
  });
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { UA_DESKTOP, UA_MOBILE, norm, nameMatches, hostOf, domainMatches, pool, fetchWithTimeout, sleep };
