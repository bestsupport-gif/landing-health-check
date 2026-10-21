const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PL = { meta: 'Meta', google: 'Google', naver: 'Naver' };
const LV = { critical: 'OFF 제안', warn: '점검 필요', info: '수동 확인', ok: '정상' };
const TYPE = { error: '404/접속오류', soft404: '페이지 없음', soldout: '품절', soldout_suspect: '품절 의심', price_change: '가격 변경', price_mismatch: '가격 불일치', utm_missing: 'UTM 누락', redirect_home: '메인 리다이렉트', blocked: '확인 불가', no_url: 'URL 비공개', skipped: '점검 제외' };

let advertisers = [];
let current = location.hash.slice(1) || null;
let result = null;
let filter = { level: 'issue', type: '', platform: '', q: '' };
let pollTimer = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
}

async function loadAdvertisers() {
  advertisers = await api('/api/advertisers');
  renderList();
  if (!current && advertisers.length) current = advertisers[0].id;
  if (current && advertisers.some(a => a.id === current)) await select(current, true);
}

function renderList() {
  $('#advList').innerHTML = advertisers.map(a => {
    const s = a.lastRun?.summary;
    const busy = a.job && ['queued', 'running'].includes(a.job.status);
    const badge = busy ? '<span class="badge b-info">점검 중…</span>'
      : !s ? '<span class="badge b-info">대기</span>'
      : s.critical ? `<span class="badge b-critical">OFF ${s.critical}</span>`
      : s.warn ? `<span class="badge b-warn">점검 ${s.warn}</span>` : '<span class="badge b-ok">정상</span>';
    return `<div class="adv ${a.id === current ? 'active' : ''}" data-id="${a.id}">
      <div class="nm"><span>${esc(a.name)}</span>${badge}</div>
      <div class="meta">${Object.keys(PL).filter(p => a.platforms?.[p] !== false).map(p => PL[p]).join(' · ')} · ${s ? `소재 ${s.ads} · ${fmtTime(a.lastRun.startedAt)}` : '결과 없음'}</div>
    </div>`;
  }).join('');
}

async function select(id, keepFilter) {
  current = id;
  location.hash = id;
  if (!keepFilter) filter = { level: 'issue', type: '', platform: '', q: '' };
  renderList();
  result = await api(`/api/advertisers/${id}/result`);
  render();
  const adv = advertisers.find(a => a.id === id);
  if (adv?.job && ['queued', 'running'].includes(adv.job.status)) watchJob(adv.job.id);
}

function rowsFiltered() {
  const rows = result?.run?.rows || [];
  return rows.filter(r => {
    if (filter.level === 'issue' && !['critical', 'warn'].includes(r.level)) return false;
    if (['critical', 'warn', 'ok', 'info'].includes(filter.level) && r.level !== filter.level) return false;
    if (filter.platform && r.platform !== filter.platform) return false;
    if (filter.type && !r.issues.some(i => i.type === filter.type)) return false;
    if (filter.q) {
      const q = filter.q.toLowerCase();
      if (![r.title, r.landingUrl, r.finalUrl, r.advertiser, r.adId].some(v => String(v || '').toLowerCase().includes(q))) return false;
    }
    return true;
  });
}

function render() {
  const adv = advertisers.find(a => a.id === current);
  if (!adv) return;
  const run = result?.run;
  const s = run?.summary;
  const types = s ? Object.entries(s.byType).sort((a, b) => b[1] - a[1]) : [];
  const rows = rowsFiltered();

  $('#main').innerHTML = `
    <div class="head">
      <div>
        <h2>${esc(adv.name)}</h2>
        <div class="sub">${run ? `마지막 점검 ${fmtTime(run.startedAt)} · 랜딩 URL ${s.urls}개` : '아직 점검 결과가 없습니다'}
          ${adv.domains?.length ? ` · 도메인 ${esc(adv.domains.join(', '))}` : ''}</div>
      </div>
      <div class="acts">
        <button class="primary" id="btnRun">지금 점검</button>
        ${run ? `<a href="/api/advertisers/${adv.id}/report.csv"><button>CSV (On/Off 제안)</button></a>` : ''}
        <button class="ghost" id="btnEdit">설정</button>
        <button class="ghost" id="btnDel">삭제</button>
      </div>
    </div>
    <div id="jobLog"></div>
    ${run ? `
    <div class="stats">
      <div class="stat crit"><div class="k">OFF 제안 (404·품절)</div><div class="v">${s.critical}</div></div>
      <div class="stat warn"><div class="k">점검 필요 (가격·UTM)</div><div class="v">${s.warn}</div></div>
      <div class="stat ok"><div class="k">정상</div><div class="v">${s.ok}</div></div>
      <div class="stat"><div class="k">집행 소재</div><div class="v">${s.ads}</div></div>
    </div>
    <div class="plats">${Object.entries(run.platformStatus).map(([p, st]) =>
      `<span class="plat ${st.ok ? '' : 'err'}">${PL[p]} ${st.ok ? `소재 ${st.ads}건` : `수집 실패: ${esc(st.error)}`}</span>`).join('')}
      ${run.platformStatus.naver?.ok && run.platformStatus.naver.ads === 0 ? '<span class="plat">네이버 파워링크에서 못 찾았다면 설정에서 네이버 키워드·도메인을 추가하세요</span>' : ''}
    </div>
    <div class="filters">
      ${[['issue', '이슈만'], ['critical', 'OFF 제안'], ['warn', '점검 필요'], ['ok', '정상'], ['info', '수동 확인'], ['all', '전체']].map(([k, l]) =>
        `<button data-level="${k}" class="${filter.level === k ? 'on' : ''}">${l}</button>`).join('')}
      <select id="fPlat"><option value="">전체 매체</option>${Object.keys(PL).map(p => `<option value="${p}" ${filter.platform === p ? 'selected' : ''}>${PL[p]}</option>`).join('')}</select>
      <select id="fType"><option value="">전체 이슈 유형</option>${types.map(([t, n]) => `<option value="${t}" ${filter.type === t ? 'selected' : ''}>${TYPE[t] || t} (${n})</option>`).join('')}</select>
      <input id="fQ" placeholder="소재명·URL 검색" value="${esc(filter.q)}">
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>제안</th><th>매체</th><th>소재</th><th>이슈</th><th>랜딩 URL</th><th>가격</th></tr></thead>
      <tbody>${rows.length ? rows.slice(0, 500).map(rowHtml).join('') : '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:30px">해당하는 소재가 없습니다</td></tr>'}</tbody>
    </table></div>
    <p class="note">※ 랜딩 URL은 각 매체의 공개 광고 라이브러리에 노출된 값 기준입니다. 네이버는 광고 클릭(과금) URL을 호출하지 않고 표시 URL만 점검하므로 UTM 점검에서 제외됩니다.</p>
    ` : ''}`;

  $('#btnRun').onclick = runNow;
  $('#btnDel').onclick = del;
  $('#btnEdit').onclick = edit;
  document.querySelectorAll('[data-level]').forEach(b => b.onclick = () => { filter.level = b.dataset.level; render(); });
  const fp = $('#fPlat'); if (fp) fp.onchange = e => { filter.platform = e.target.value; render(); };
  const ft = $('#fType'); if (ft) ft.onchange = e => { filter.type = e.target.value; render(); };
  const fq = $('#fQ'); if (fq) fq.oninput = e => { filter.q = e.target.value; clearTimeout(fq._t); fq._t = setTimeout(() => { render(); $('#fQ').focus(); $('#fQ').setSelectionRange(filter.q.length, filter.q.length); }, 250); };
}

function rowHtml(r) {
  return `<tr>
    <td><span class="badge b-${r.level}">${LV[r.level]}</span></td>
    <td><span class="pl">${PL[r.platform]}</span>${r.format ? `<div class="hint">${esc(r.format)}</div>` : ''}</td>
    <td class="title"><a href="${esc(r.adUrl)}" target="_blank" rel="noopener">${esc(r.title || r.adId)}</a><div class="hint">${esc(r.advertiser)}</div></td>
    <td><ul class="issues">${r.issues.length ? r.issues.map(i => `<li class="${i.level}">${esc(i.msg)}</li>`).join('') : '<li class="info">문제 없음</li>'}</ul></td>
    <td class="url">${r.landingUrl ? `<a href="${esc(r.landingUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.landingUrl)}</a>` : '-'}
      ${r.finalUrl && r.finalUrl !== r.landingUrl ? `<div class="fin">→ ${esc(r.finalUrl)}</div>` : ''}
      ${r.httpStatus ? `<div class="fin">HTTP ${r.httpStatus}${r.pageTitle ? ' · ' + esc(r.pageTitle.slice(0, 40)) : ''}</div>` : ''}</td>
    <td>${r.price ? r.price.toLocaleString('ko-KR') + '원' : '-'}</td>
  </tr>`;
}

async function runNow() {
  const job = await api(`/api/advertisers/${current}/check`, { method: 'POST' });
  watchJob(job.id);
}

function watchJob(jobId) {
  clearInterval(pollTimer);
  const tick = async () => {
    let job;
    try { job = await api(`/api/jobs/${jobId}`); } catch { clearInterval(pollTimer); return; }
    const el = $('#jobLog');
    if (el && job.advertiserId === current) {
      el.innerHTML = `<div class="log">${esc(job.status === 'queued' ? '대기열에서 순서를 기다리는 중…' : job.log.slice(-12).join('\n'))}</div>`;
      el.firstChild.scrollTop = el.firstChild.scrollHeight;
    }
    const btn = $('#btnRun'); if (btn) btn.disabled = true;
    if (['done', 'error'].includes(job.status)) {
      clearInterval(pollTimer);
      advertisers = await api('/api/advertisers');
      renderList();
      if (job.advertiserId === current) {
        result = await api(`/api/advertisers/${current}/result`);
        render();
        if (job.status === 'error') $('#jobLog').innerHTML = `<div class="log">${esc(job.log.slice(-5).join('\n'))}</div>`;
      }
    }
  };
  tick();
  pollTimer = setInterval(tick, 2000);
}

async function del() {
  const adv = advertisers.find(a => a.id === current);
  if (!confirm(`'${adv.name}' 모니터링을 삭제할까요?`)) return;
  await api(`/api/advertisers/${current}`, { method: 'DELETE' });
  current = null; location.hash = '';
  $('#main').innerHTML = '<div class="empty"><h2>삭제했습니다</h2></div>';
  await loadAdvertisers();
}

async function edit() {
  const adv = advertisers.find(a => a.id === current);
  const ask = (label, v) => prompt(`${label} (쉼표로 구분)`, (v || []).join(', '));
  const aliases = ask('다른 이름(별칭)', adv.aliases); if (aliases === null) return;
  const domains = ask('광고주 도메인', adv.domains); if (domains === null) return;
  const naverKeywords = ask('네이버 검색 키워드', adv.naverKeywords); if (naverKeywords === null) return;
  await api(`/api/advertisers/${current}`, { method: 'PUT', body: { aliases, domains, naverKeywords } });
  advertisers = await api('/api/advertisers');
  render();
}

$('#addForm').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = Object.fromEntries(['name', 'aliases', 'domains', 'naverKeywords', 'metaPageIds', 'googleAdvertiserIds'].map(k => [k, f.get(k)]));
  body.platforms = { meta: !!f.get('meta'), google: !!f.get('google'), naver: !!f.get('naver') };
  const btn = e.target.querySelector('button'); btn.disabled = true;
  try {
    const adv = await api('/api/advertisers', { method: 'POST', body });
    e.target.reset();
    advertisers = await api('/api/advertisers');
    await select(adv.id);
    if (adv.job) watchJob(adv.job.id);
  } catch (err) { alert(err.message); }
  btn.disabled = false;
};

$('#advList').onclick = e => { const el = e.target.closest('.adv'); if (el) select(el.dataset.id); };

$('#btnCheckAll').onclick = async () => {
  const r = await api('/api/check-all', { method: 'POST' });
  alert(`${r.queued}개 광고주 점검을 대기열에 넣었습니다`);
  advertisers = await api('/api/advertisers'); renderList();
};

$('#btnSettings').onclick = async () => {
  const s = await api('/api/settings');
  $('#settingsHint').textContent = `현재: ${s.slackWebhook ? '웹훅 설정됨' : s.slackFromEnv ? '환경변수 웹훅 사용 중' : '알림 꺼짐'} · 정기 점검 주기(cron): ${s.cron}. 새로 생긴 OFF 제안/점검 이슈만 알립니다.`;
  $('#settings').showModal();
};
$('#settingsForm').onsubmit = async e => {
  if (e.submitter?.value !== 'save') return;
  const v = new FormData(e.target).get('slackWebhook');
  try { await api('/api/settings', { method: 'PUT', body: { slackWebhook: v } }); } catch (err) { alert(err.message); }
};

window.onhashchange = () => { const id = location.hash.slice(1); if (id && id !== current && advertisers.some(a => a.id === id)) select(id); };
loadAdvertisers();
