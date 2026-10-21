// 슬랙 웹훅 알림 (설정 화면 또는 SLACK_WEBHOOK_URL 환경변수)
const store = require('./store');

const PLATFORM = { meta: 'Meta', google: 'Google', naver: 'Naver' };

async function notify(adv, run, newIssues) {
  const hook = store.load().settings.slackWebhook || process.env.SLACK_WEBHOOK_URL;
  if (!hook) return;
  const base = process.env.PUBLIC_URL || '';
  const critical = newIssues.filter(i => i.level === 'critical');
  const lines = newIssues.slice(0, 15).map(i =>
    `${i.level === 'critical' ? '🔴' : '🟡'} [${PLATFORM[i.row.platform]}] ${i.msg}\n    ${i.row.landingUrl || ''}  <${i.row.adUrl}|소재 보기>`);
  const text = [
    `*랜딩 헬스체크 · ${adv.name}* — 신규 이슈 ${newIssues.length}건 (OFF 제안 ${critical.length}건)`,
    ...lines,
    newIssues.length > 15 ? `…외 ${newIssues.length - 15}건` : '',
    base ? `<${base}/#${adv.id}|전체 결과 보기>` : '',
  ].filter(Boolean).join('\n');
  const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error(`Slack HTTP ${r.status}`);
}

module.exports = { notify };
