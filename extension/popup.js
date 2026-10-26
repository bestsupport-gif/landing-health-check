const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PL = { meta: 'Meta', google: 'Google', naver: 'Naver' };
const LV = { critical: 'OFF/랜딩 수정', warn: '점검 필요', info: '수동 확인', ok: '정상' };
const hasChrome = typeof chrome !== 'undefined' && !!chrome.tabs;

let advertisers = [];
let current = null;
let result = null;
let level = 'issue';

const fmtTime = iso => (iso ? new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-');

// URL 비교용: 프로토콜·www/m·추적 파라미터·끝 슬래시 제거
function key(u) {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid|n_|NaPm|af_|ets_)/i.test(k)) x.searchParams.delete(k);
    return (x.hostname.replace(/^(www|m)\./, '') + x.pathname.replace(/\/+$/, '') + (x.search || '')).toLowerCase();
  } catch { return ''; }
}

async function currentTabUrl() {
  if (!hasChrome) return '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || '';
}

async function load() {
  $('#rows').innerHTML = '<li class="empty">불러오는 중…</li>';
  try {
    advertisers = await loadAdvertisers();
  } catch (e) {
    $('#rows').innerHTML = `<li class="empty">결과를 불러오지 못했어요 (${esc(e.message)})</li>`;
    return;
  }
  const b = badgeOf(advertisers);
  $('#dot').style.background = b.critical ? 'var(--crit)' : b.warn ? 'var(--warn)' : 'var(--ok)';
  const last = advertisers.map(a => a.lastRun?.startedAt).filter(Boolean).sort().pop();
  $('#updated').textContent = `마지막 점검 ${fmtTime(last)} · 6시간마다 자동 점검`;
  $('#advTabs').innerHTML = advertisers.length > 1
    ? advertisers.map(a => `<button data-id="${esc(a.id)}">${esc(a.name)}${a.lastRun?.summary?.critical ? ` <span class="badge b-critical">${a.lastRun.summary.critical}</span>` : a.lastRun?.summary?.warn ? ` <span class="badge b-warn">${a.lastRun.summary.warn}</span>` : ''}</button>`).join('')
    : '';
  const saved = hasChrome ? (await chrome.storage.local.get('current')).current : null;
  await select(advertisers.some(a => a.id === saved) ? saved : advertisers[0]?.id);
  checkCurrentTab();
  if (hasChrome) chrome.runtime.sendMessage('refresh').catch(() => {});
}

async function select(id) {
  if (!id) { $('#rows').innerHTML = '<li class="empty">모니터링 중인 광고주가 없어요</li>'; return; }
  current = id;
  if (hasChrome) chrome.storage.local.set({ current: id });
  document.querySelectorAll('#advTabs button').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  $('#lnkPage').href = `${LINKS.page}#${encodeURIComponent(id)}`;
  $('#lnkCsv').href = `${BASE}data/results/${encodeURIComponent(id)}.csv`;
  $('#lnkRun').href = LINKS.run;
  $('#lnkEdit').href = LINKS.edit;
  result = await loadResult(id).catch(() => null);
  render();
}

function render() {
  const adv = advertisers.find(a => a.id === current);
  const run = result?.run;
  if (!run) {
    $('#summary').innerHTML = '';
    $('#filters').innerHTML = '';
    $('#rows').innerHTML = '<li class="empty">아직 점검 결과가 없어요</li>';
    return;
  }
  const s = run.summary;
  $('#summary').innerHTML = `
    <div class="stats">
      <div class="stat crit"><div class="k">OFF/랜딩 수정</div><div class="v">${s.critical}</div></div>
      <div class="stat warn"><div class="k">점검 필요</div><div class="v">${s.warn}</div></div>
      <div class="stat ok"><div class="k">정상</div><div class="v">${s.ok}</div></div>
      <div class="stat"><div class="k">소재</div><div class="v">${s.ads}</div></div>
    </div>
    <div class="plats">${esc(adv?.name || '')} · ${Object.entries(run.platformStatus).map(([p, st]) =>
      st.ok ? `${PL[p]} ${st.ads}건` : `<span class="err">${PL[p]} 수집 실패</span>`).join(' · ')}</div>`;
  $('#filters').innerHTML = [['issue', '이슈만'], ['critical', 'OFF/수정'], ['warn', '점검 필요'], ['all', '전체']]
    .map(([k, l]) => `<button data-level="${k}" class="${level === k ? 'on' : ''}">${l}</button>`).join('');

  const rows = run.rows.filter(r => level === 'all' ? true : level === 'issue' ? ['critical', 'warn'].includes(r.level) : r.level === level);
  $('#rows').innerHTML = rows.length
    ? rows.slice(0, 80).map(rowHtml).join('') + (rows.length > 80 ? `<li class="empty">…외 ${rows.length - 80}건은 전체 결과에서 확인</li>` : '')
    : `<li class="empty">${level === 'issue' ? '문제 있는 소재가 없어요 👍' : '해당하는 소재가 없어요'}</li>`;
}

function rowHtml(r) {
  const issues = r.issues.filter(i => i.level !== 'info' || r.level === 'info');
  return `<li>
    <div class="top"><span class="badge b-${r.level}">${LV[r.level]}</span><span class="pl">${PL[r.platform]}</span>
      <a class="title" href="${esc(r.adUrl)}" target="_blank" title="${esc(r.title)}">${esc(r.title || r.adId)}</a></div>
    ${issues.map(i => `<div class="msg ${i.level}">${esc(i.msg)}</div>`).join('') || '<div class="msg">문제 없음</div>'}
    ${r.landingUrl ? `<a class="url" href="${esc(r.landingUrl)}" target="_blank" title="${esc(r.landingUrl)}">${esc(r.landingUrl)}</a>` : ''}
  </li>`;
}

// 지금 보고 있는 탭이 점검된 랜딩이면 결과를 위에 보여 준다 (모든 광고주 대상)
async function checkCurrentTab() {
  const url = await currentTabUrl();
  const k = key(url);
  if (!k) return;
  const hits = [];
  for (const a of advertisers) {
    const res = a.id === current ? result : await loadResult(a.id).catch(() => null);
    for (const r of res?.run?.rows || []) {
      if (r.landingUrl && (key(r.landingUrl) === k || key(r.finalUrl || '') === k)) hits.push({ a, r });
    }
  }
  if (!hits.length) return;
  const worst = hits.sort((x, y) => ['critical', 'warn', 'info', 'ok'].indexOf(x.r.level) - ['critical', 'warn', 'info', 'ok'].indexOf(y.r.level))[0];
  const msgs = [...new Set(hits.flatMap(h => h.r.issues.filter(i => i.level !== 'info').map(i => i.msg)))];
  $('#tabBox').hidden = false;
  $('#tabBox').innerHTML = `<h4>지금 보고 있는 페이지 — <span class="badge b-${worst.r.level}">${LV[worst.r.level]}</span></h4>
    <div>${esc(worst.a.name)} 소재 ${hits.length}건이 이 페이지로 연결돼요${worst.r.pageType ? ` · ${worst.r.pageType === 'product' ? '상품 직랜딩' : worst.r.pageType === 'listing' ? '기획전/목록' : '일반 페이지'}` : ''}</div>
    ${msgs.map(m => `<div class="msg ${worst.r.level}">${esc(m)}</div>`).join('')}`;
}

$('#advTabs').onclick = e => { const b = e.target.closest('button'); if (b) select(b.dataset.id); };
$('#filters').onclick = e => { const b = e.target.closest('button'); if (b) { level = b.dataset.level; render(); } };
$('#btnReload').onclick = load;
load();
