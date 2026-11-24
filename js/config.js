export const CONFIG = {
  LAUNCH_EPOCH: '2026-11-23',
  PUZZLES_URL: './puzzles.json',
  CHECKOUT_URL: 'https://tally.so/r/7XNpz9',
  SHARE_URL: window.location.origin + window.location.pathname,
  STORAGE_KEY: 'redline_v5_state',
  SUPABASE_URL: 'https://plhcylbhoktzkkxczecu.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_KFh62lKVQfGvl5Hp6MbfpA_S2BsfmKI',
  MAX_ATTEMPTS: 3,
  WRONG_TAP_PENALTY_MS: 3000,
  NUDGE_PENALTY_MS: 5000,
  SKELETON_DELAY_MS: 180,
  LANGUAGES: [
    { id: 'python', label: 'Python' },
    { id: 'cpp', label: 'C++' },
    { id: 'java', label: 'Java' },
    { id: 'sql', label: 'SQL' }
  ],
  CAREER_RANKS: [
    { name: 'Intern', minXP: 0 },
    { name: 'Junior', minXP: 150 },
    { name: 'Senior', minXP: 400 },
    { name: 'Staff', minXP: 750 },
    { name: 'Principal', minXP: 1200 }
  ]
};

export function trackEvent(name, props = {}) {
  if (window.umami && typeof window.umami.track === 'function') {
    window.umami.track(name, props);
  }
}

export function formatDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getLocalDateKey() {
  return formatDateKey(new Date());
}

export function getYesterdayDateKey() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return formatDateKey(yesterday);
}

function computeDailyIssueInfo() {
  const todayKey = getLocalDateKey();
  const [ey, em, ed] = CONFIG.LAUNCH_EPOCH.split('-').map(Number);
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const epochUtc = Date.UTC(ey, em - 1, ed);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  const diffDays = Math.floor((todayUtc - epochUtc) / 86400000);
  const issueNum = Math.max(1, diffDays + 1);
  return {
    dateKey: todayKey,
    issueNum,
    issueLabel: String(issueNum).padStart(3, '0')
  };
}

export const TODAY_ISSUE = computeDailyIssueInfo();