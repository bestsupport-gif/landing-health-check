// 서버 API 와 정적 빌드(GitHub Pages)가 같이 쓰는 결과 변환

function advertiserSummary(adv, run, job) {
  return {
    ...adv,
    lastRun: run ? { startedAt: run.startedAt, summary: run.summary, platformStatus: run.platformStatus } : null,
    job: job ? { id: job.id, status: job.status } : null,
  };
}

// 소재 On/Off 제안 연동용 CSV
function toCsv(run) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['플랫폼', '소재ID', '광고주(노출명)', '소재', '제안', '심각도', '이슈', '랜딩유형', '랜딩URL', '최종URL', 'HTTP', '랜딩가격', '소재링크', '점검시각'];
  const lines = run.rows.map(r => [r.platform, r.adId, r.advertiser, r.title, r.action, r.level, r.issues.map(i => i.msg).join(' / '),
    r.pageType, r.landingUrl, r.finalUrl, r.httpStatus, r.price, r.adUrl, run.startedAt].map(esc).join(','));
  return '﻿' + [head.map(esc).join(','), ...lines].join('\n');
}

function toReportJson(run) {
  return { ...run, rows: run.rows.map(r => ({ platform: r.platform, adId: r.adId, action: r.action, level: r.level, issues: r.issues, landingUrl: r.landingUrl })) };
}

module.exports = { advertiserSummary, toCsv, toReportJson };
