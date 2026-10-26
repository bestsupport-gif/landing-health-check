// 30분마다 최신 점검 결과를 받아 툴바 배지를 갱신하고, 새 점검에서 신규 이슈가 있으면 알림을 띄운다
importScripts('common.js');

const ALARM = 'refresh';

async function refresh() {
  let advertisers;
  try {
    advertisers = await loadAdvertisers();
  } catch {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#667085' });
    chrome.action.setTitle({ title: '랜딩 헬스체크 — 결과를 불러오지 못했어요' });
    return;
  }
  const b = badgeOf(advertisers);
  chrome.action.setBadgeText({ text: b.text });
  chrome.action.setBadgeBackgroundColor({ color: b.color });
  chrome.action.setTitle({ title: `랜딩 헬스체크 — OFF/랜딩 수정 ${b.critical}건 · 점검 필요 ${b.warn}건` });

  // 광고주별 마지막 점검 시각을 기억해 두고, 새 점검이 들어왔을 때 신규 이슈가 있으면 알림
  const { seen = {} } = await chrome.storage.local.get('seen');
  const next = {};
  for (const a of advertisers) {
    const run = a.lastRun;
    if (!run) continue;
    next[a.id] = run.startedAt;
    const isNew = seen[a.id] && seen[a.id] !== run.startedAt;
    if (isNew && run.newIssueCount > 0) {
      chrome.notifications.create(`adv:${a.id}:${run.startedAt}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: `${a.name} — 신규 이슈 ${run.newIssueCount}건`,
        message: `OFF/랜딩 수정 ${run.summary.critical}건 · 점검 필요 ${run.summary.warn}건`,
        priority: run.summary.critical ? 2 : 1,
      });
    }
  }
  await chrome.storage.local.set({ seen: next, lastFetch: Date.now() });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 30 });
  refresh();
});
chrome.runtime.onStartup.addListener(refresh);
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) refresh(); });
chrome.notifications.onClicked.addListener(id => {
  const advId = id.split(':')[1];
  chrome.tabs.create({ url: `${LINKS.page}#${advId}` });
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === 'refresh') refresh().then(() => reply(true));
  return true;
});
