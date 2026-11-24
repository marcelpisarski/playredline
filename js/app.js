import { CONFIG, TODAY_ISSUE, getYesterdayDateKey, trackEvent } from './config.js';
import { AUDIO } from './audio.js';
import { sb, STORAGE } from './storage.js';

let PUZZLE_BANK = null;
let currentUser = null;
let hasActivePass = false;
let state = STORAGE.loadLocal();
AUDIO.enabled = state.soundEnabled;

let clockRaf = null;
let lastTickTs = null;
let showHeatmap = false;
let resetArmed = false;
let resetTimeout = null;
let countdownInterval = null;

async function ensurePuzzlesLoaded() {
  if (PUZZLE_BANK) return PUZZLE_BANK;
  const res = await fetch(CONFIG.PUZZLES_URL, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while loading ${CONFIG.PUZZLES_URL}`);
  }
  const dailyIssues = await res.json();
  if (!Array.isArray(dailyIssues) || dailyIssues.length === 0) {
    throw new Error('puzzles.json is empty or malformed.');
  }
  PUZZLE_BANK = dailyIssues[(TODAY_ISSUE.issueNum - 1) % dailyIssues.length];
  return PUZZLE_BANK;
}

function shuffleIndices(len) {
  const arr = Array.from({ length: len }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createFreshRun(isPractice = false) {
  return {
    started: false,
    roundIndex: 0,
    step: 1,
    totalMs: 0,
    roundMs: 0,
    splits: [null, null, null],
    splitOutcomes: [null, null, null],
    choiceOrders: [shuffleIndices(3), shuffleIndices(3), shuffleIndices(3)],
    wrongLines: [],
    wrongChoices: [],
    patchDraft: null,
    patchedCode: null,
    usedNudge: false,
    totalMistakes: 0,
    totalNudges: 0,
    isPractice
  };
}

function getRun(lang) {
  if (!state.activeRuns[lang]) {
    state.activeRuns[lang] = createFreshRun(false);
  } else if (typeof state.activeRuns[lang].started === 'undefined') {
    const r = state.activeRuns[lang];
    r.started = r.totalMs > 0 || r.step > 1 || r.roundIndex > 0;
  }
  return state.activeRuns[lang];
}

function getCareerRank(xp) {
  let current = CONFIG.CAREER_RANKS[0].name;
  for (const r of CONFIG.CAREER_RANKS) {
    if (xp >= r.minXP) current = r.name;
  }
  return current;
}

function computeSpeedrunRank(totalMs, mistakes, nudges) {
  const sec = totalMs / 1000;
  if (sec <= 38 && mistakes === 0 && nudges === 0) return 'S-RANK';
  if (sec <= 65 && mistakes <= 1) return 'A-RANK';
  if (sec <= 105) return 'B-RANK';
  return 'C-RANK';
}

function formatStopwatch(ms) {
  const clamped = Math.max(0, Math.floor(ms));
  const mins = Math.floor(clamped / 60000);
  const secs = Math.floor((clamped % 60000) / 1000);
  const centis = Math.floor((clamped % 1000) / 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function formatSplitShort(ms) {
  return (ms / 1000).toFixed(1) + 's';
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeCode(str) {
  return str
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;[\]{}])\s*/g, '$1')
    .replace(/\s*([=+\-*/<>!]+)\s*/g, ' $1 ')
    .replace(/\s+/g, ' ');
}

function parseRegexRule(rule) {
  const body = rule.slice(3);
  const match = body.match(/^\/(.+)\/([gimsuy]*)$/);
  return match ? new RegExp(match[1], match[2]) : new RegExp(body);
}

function isPatchValid(input, patch) {
  const raw = input.trim();
  const norm = normalizeCode(raw);
  return patch.accept.some((rule) => {
    if (rule instanceof RegExp) return rule.test(raw);
    if (typeof rule === 'string' && rule.startsWith('re:')) {
      try {
        return parseRegexRule(rule).test(raw);
      } catch (e) {
        return false;
      }
    }
    return normalizeCode(rule) === norm;
  });
}

function getActiveWordBounds(inputEl) {
  const pos = inputEl.selectionStart ?? inputEl.value.length;
  const before = inputEl.value.slice(0, pos);
  const match = before.match(/[A-Za-z0-9_."']+$/);
  const start = match ? pos - match[0].length : pos;
  return { start, end: pos, word: match ? match[0] : '' };
}

function insertTokenAtCursor(inputEl, token) {
  const { start, end, word } = getActiveWordBounds(inputEl);
  const replaceStart = word && token.toLowerCase().startsWith(word.toLowerCase()) ? start : end;
  const nextVal = inputEl.value.slice(0, replaceStart) + token + inputEl.value.slice(end);
  inputEl.value = nextVal;
  const caret = replaceStart + token.length;
  inputEl.setSelectionRange(caret, caret);
  inputEl.focus();
}

function highlightCode(line, lang) {
  const commentPattern = lang === 'python' ? '#.*$' : (lang === 'sql' ? '--.*$' : '//.*$');
  const keywords = {
    python: 'def|for|in|if|else|return|True|False|and|or|not|None|lambda',
    cpp: 'int|double|bool|void|const|return|while|if|else|for|auto|class|public|virtual|size_t|std|vector|string|unordered_map|cout',
    java: 'public|private|final|volatile|class|boolean|void|int|if|return|for|this|null|true|false|instanceof|String|List|Integer|Object|Arrays|Objects',
    sql: 'SELECT|FROM|WHERE|GROUP|BY|ORDER|DESC|ASC|AS|LEFT|JOIN|ON|NOT|IN|AND|OR|IS|NULL|COUNT|AVG|SUM|COALESCE|UNION|ALL|OVER|PARTITION|ROW_NUMBER'
  }[lang] || '';
  const regex = new RegExp(
    `(${commentPattern})|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')|\\b(${keywords})\\b|\\b(\\d+(?:\\.\\d+)?)\\b`,
    'g'
  );
  let out = '';
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      out += escapeHtml(line.slice(lastIndex, match.index));
    }
    const [full, comment, str, kw, num] = match;
    if (comment) {
      out += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
    } else if (str) {
      out += `<span class="tok-str">${escapeHtml(str)}</span>`;
    } else if (kw) {
      out += `<span class="tok-kw">${escapeHtml(kw)}</span>`;
    } else if (num) {
      out += `<span class="tok-num">${escapeHtml(num)}</span>`;
    } else {
      out += escapeHtml(full);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < line.length) {
    out += escapeHtml(line.slice(lastIndex));
  }
  return out;
}

function stopClock() {
  if (clockRaf) {
    cancelAnimationFrame(clockRaf);
    clockRaf = null;
  }
  lastTickTs = null;
}

function startClock() {
  stopClock();
  const lang = state.lang;
  const record = state.dailyRecords[lang];
  const run = getRun(lang);
  if (!run.started || (record && record.completed && !run.isPractice) || run.step === 3) {
    return;
  }
  lastTickTs = performance.now();
  const tick = (now) => {
    const activeRun = getRun(state.lang);
    const activeRec = state.dailyRecords[state.lang];
    if (!activeRun.started || (activeRec && activeRec.completed && !activeRun.isPractice) || activeRun.step === 3) {
      stopClock();
      return;
    }
    const delta = Math.min(250, now - lastTickTs);
    lastTickTs = now;
    activeRun.totalMs += delta;
    activeRun.roundMs += delta;
    els.stopwatchDisplay.textContent = formatStopwatch(activeRun.totalMs);
    clockRaf = requestAnimationFrame(tick);
  };
  clockRaf = requestAnimationFrame(tick);
}

function saveMistake(puzzle, langId) {
  if (state.mistakes.some(m => m.id === puzzle.id)) return;
  const langLabel = (CONFIG.LANGUAGES.find(l => l.id === langId) || {}).label || langId;
  state.mistakes.unshift({
    id: puzzle.id,
    langLabel,
    topic: puzzle.topic,
    filename: puzzle.filename,
    goal: puzzle.goal,
    flawLine: puzzle.flawLine,
    flawCode: puzzle.lines[puzzle.flawLine - 1] || '',
    examRule: puzzle.examRule
  });
  STORAGE.save(state, currentUser);
  renderMistakeBadge();
}

const els = {
  headerIssueBadge: document.getElementById('header-issue-badge'),
  practiceBadge: document.getElementById('practice-badge'),
  headerPassBtn: document.getElementById('header-pass-btn'),
  mistakesBtn: document.getElementById('mistakes-btn'),
  mistakesCount: document.getElementById('mistakes-count'),
  themeToggle: document.getElementById('theme-toggle'),
  soundToggle: document.getElementById('sound-toggle'),
  stopwatchDisplay: document.getElementById('stopwatch-display'),
  penaltyFloat: document.getElementById('penalty-float'),
  splitsHud: document.getElementById('splits-hud'),
  langSwitcher: document.getElementById('lang-switcher'),
  careerRankPill: document.getElementById('career-rank-pill'),
  streakCount: document.getElementById('streak-count'),
  offlineBanner: document.getElementById('offline-banner'),

  loadingView: document.getElementById('loading-view'),
  errorView: document.getElementById('error-view'),
  errorMessage: document.getElementById('error-message'),
  retryLoadBtn: document.getElementById('retry-load-btn'),
  gameView: document.getElementById('game-view'),
  receiptView: document.getElementById('receipt-view'),

  stepPill: document.getElementById('step-pill'),
  stepLabel: document.getElementById('step-label'),
  nudgeBtn: document.getElementById('nudge-btn'),
  roundTag: document.getElementById('round-tag'),
  topicTag: document.getElementById('topic-tag'),
  attemptsPips: document.getElementById('attempts-pips'),
  goalText: document.getElementById('goal-text'),
  nudgeBox: document.getElementById('nudge-box'),
  nudgeText: document.getElementById('nudge-text'),
  inlineFeedback: document.getElementById('inline-feedback'),
  inlineFeedbackText: document.getElementById('inline-feedback-text'),
  codeFilename: document.getElementById('code-filename'),
  codeLines: document.getElementById('code-lines'),
  startOverlay: document.getElementById('start-overlay'),
  startRunBtn: document.getElementById('start-run-btn'),

  diagnosisPanel: document.getElementById('diagnosis-panel'),
  diagnosisTitle: document.getElementById('diagnosis-title'),
  diagnosisChoices: document.getElementById('diagnosis-choices'),
  diagnosisError: document.getElementById('diagnosis-error'),

  patchPanel: document.getElementById('patch-panel'),
  patchTitle: document.getElementById('patch-title'),
  patchTokens: document.getElementById('patch-tokens'),
  patchResetBtn: document.getElementById('patch-reset-btn'),
  patchSubmitBtn: document.getElementById('patch-submit-btn'),
  patchError: document.getElementById('patch-error'),

  roundClearedPanel: document.getElementById('round-cleared-panel'),
  clearedBadge: document.getElementById('cleared-badge'),
  clearedSplitTime: document.getElementById('cleared-split-time'),
  toggleHeatmapBtn: document.getElementById('toggle-heatmap-btn'),
  toggleHeatmapLabel: document.getElementById('toggle-heatmap-label'),
  crowdTrapBanner: document.getElementById('crowd-trap-banner'),
  crowdTrapStat: document.getElementById('crowd-trap-stat'),
  examRuleText: document.getElementById('exam-rule-text'),
  nextRoundBtn: document.getElementById('next-round-btn'),
  nextRoundBtnText: document.getElementById('next-round-btn-text'),

  receiptIssueBadge: document.getElementById('receipt-issue-badge'),
  receiptLangBadge: document.getElementById('receipt-lang-badge'),
  receiptFinalTime: document.getElementById('receipt-final-time'),
  receiptPbLine: document.getElementById('receipt-pb-line'),
  receiptRankStamp: document.getElementById('receipt-rank-stamp'),
  receiptSplitsGrid: document.getElementById('receipt-splits-grid'),
  receiptCareerRank: document.getElementById('receipt-career-rank'),
  receiptXpGain: document.getElementById('receipt-xp-gain'),
  receiptStreak: document.getElementById('receipt-streak'),
  receiptCareerBar: document.getElementById('receipt-career-bar'),
  receiptCareerProgressLabel: document.getElementById('receipt-career-progress-label'),
  receiptCareerNextLabel: document.getElementById('receipt-career-next-label'),
  copyReceiptBtn: document.getElementById('copy-receipt-btn'),
  copyReceiptText: document.getElementById('copy-receipt-text'),
  replayPbBtn: document.getElementById('replay-pb-btn'),
  suggestedLangName: document.getElementById('suggested-lang-name'),
  suggestedLangBtn: document.getElementById('suggested-lang-btn'),
  nextIssueCountdown: document.getElementById('next-issue-countdown'),
  openPassBtn: document.getElementById('open-pass-btn'),

  mistakesDrawerBackdrop: document.getElementById('mistakes-drawer-backdrop'),
  closeMistakesBtn: document.getElementById('close-mistakes-btn'),
  mistakesList: document.getElementById('mistakes-list'),

  passModal: document.getElementById('pass-modal'),
  closePassBtn: document.getElementById('close-pass-btn'),
  checkoutBtn: document.getElementById('checkout-btn'),
  waitlistForm: document.getElementById('waitlist-form'),
  waitlistEmail: document.getElementById('waitlist-email'),
  waitlistSuccess: document.getElementById('waitlist-success'),

  resetProgressBtn: document.getElementById('reset-progress-btn')
};

function updateMidnightCountdown() {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const diffSec = Math.max(0, Math.floor((tomorrow - now) / 1000));
  const h = String(Math.floor(diffSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((diffSec % 3600) / 60)).padStart(2, '0');
  const s = String(diffSec % 60).padStart(2, '0');
  if (els.nextIssueCountdown) {
    els.nextIssueCountdown.textContent = `${h}:${m}:${s}`;
  }
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  els.themeToggle.innerHTML = state.theme === 'dark'
    ? `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`
    : `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
}

function renderSoundIcon() {
  els.soundToggle.innerHTML = AUDIO.enabled
    ? `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`
    : `<svg class="w-3.5 h-3.5 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
}

function renderOfflineState() {
  els.offlineBanner.classList.toggle('hidden', navigator.onLine);
}

function renderMistakeBadge() {
  const count = state.mistakes.length;
  els.mistakesCount.textContent = count;
  els.mistakesCount.className = count > 0
    ? 'font-mono text-[10px] font-bold px-1.5 py-0.2 rounded-sm bg-vermilion text-white'
    : 'font-mono text-[10px] font-bold px-1.5 py-0.2 rounded-sm bg-subtle text-muted';
}

function flashPenalty(text, isAmber = false) {
  els.penaltyFloat.textContent = text;
  els.penaltyFloat.className = `font-mono text-xs font-bold select-none animate-penalty ${isAmber ? 'text-amber' : 'text-vermilion'}`;
  void els.penaltyFloat.offsetWidth;
  setTimeout(() => {
    els.penaltyFloat.classList.add('hidden');
  }, 1100);
}

function renderHud() {
  applyTheme();
  renderSoundIcon();
  renderMistakeBadge();
  renderOfflineState();

  document.title = `REDLINE #${TODAY_ISSUE.issueLabel} — Daily Bug-Spotting Speedrun`;
  els.headerIssueBadge.textContent = `#${TODAY_ISSUE.issueLabel}`;

  const lang = state.lang;
  const record = state.dailyRecords[lang];
  const run = getRun(lang);
  const showingReceipt = Boolean(record && record.completed && !run.isPractice);

  els.practiceBadge.classList.toggle('hidden', !run.isPractice);
  els.stopwatchDisplay.textContent = formatStopwatch(showingReceipt ? record.finalMs : run.totalMs);
  els.careerRankPill.textContent = getCareerRank(state.xp);
  els.streakCount.textContent = state.streak;

  const splits = showingReceipt ? record.splits : run.splits;
  const outcomes = showingReceipt ? (record.splitOutcomes || []) : (run.splitOutcomes || []);
  els.splitsHud.innerHTML = '';

  [0, 1, 2].forEach((idx) => {
    const splitMs = splits[idx];
    const outcome = outcomes[idx];
    const isCurrent = !showingReceipt && idx === run.roundIndex;

    const pip = document.createElement('div');
    let pipClass = 'px-2 py-1 rounded-sm border font-mono text-[10px] leading-none tabular-nums ';
    let label = `R${idx + 1}`;

    if (splitMs !== null && splitMs !== undefined) {
      if (outcome === 'missed') {
        pipClass += 'bg-vermilion-soft border-vermilion-border text-vermilion font-bold';
      } else if (outcome === 'recovered') {
        pipClass += 'bg-amber-soft border-amber-border text-amber font-bold';
      } else {
        pipClass += 'bg-emerald-soft border-emerald-border text-emerald font-bold';
      }
      label = formatSplitShort(splitMs);
    } else if (isCurrent) {
      pipClass += 'bg-paper border-ink text-ink font-bold';
      label = run.started ? `R${idx + 1} LIVE` : 'READY';
    } else {
      pipClass += 'bg-subtle/60 border-inkborder text-muted';
    }

    pip.className = pipClass;
    pip.textContent = label;
    els.splitsHud.appendChild(pip);
  });

  els.langSwitcher.innerHTML = '';
  CONFIG.LANGUAGES.forEach((l) => {
    const isActive = l.id === lang;
    const isDone = Boolean(state.dailyRecords[l.id] && state.dailyRecords[l.id].completed);
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(isActive));
    tab.className = isActive
      ? 'shrink-0 px-2.5 py-1 rounded-sm bg-ink text-paper font-mono text-[11px] font-bold flex items-center gap-1.5 cursor-pointer'
      : 'shrink-0 px-2.5 py-1 rounded-sm bg-paper border border-inkborder text-muted hover:text-ink hover:border-ink/40 font-mono text-[11px] font-semibold flex items-center gap-1.5 transition-colors cursor-pointer';
    tab.innerHTML = `<span>${l.label}</span>${isDone ? `<span class="text-[10px] ${isActive ? 'text-emerald-border' : 'text-emerald'}">✓</span>` : ''}`;
    tab.addEventListener('click', () => {
      if (state.lang === l.id) return;
      AUDIO.click();
      state.lang = l.id;
      STORAGE.save(state, currentUser);
      loadLanguageView();
    });
    els.langSwitcher.appendChild(tab);
  });
}

function renderGame() {
  const lang = state.lang;
  const puzzles = PUZZLE_BANK[lang];
  const run = getRun(lang);
  const puzzle = puzzles[run.roundIndex];

  els.loadingView.classList.add('hidden');
  els.errorView.classList.add('hidden');
  els.receiptView.classList.add('hidden');
  els.gameView.classList.remove('hidden');

  if (!run.started) {
    els.stepPill.textContent = 'READY';
    els.stepPill.className = 'shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm bg-subtle border border-inkborder text-ink';
    els.stepLabel.textContent = 'Read the goal, then start the clock';
    els.nudgeBtn.classList.add('hidden');
  } else if (run.step === 1) {
    els.stepPill.textContent = 'STEP 1';
    els.stepPill.className = 'shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm bg-ink text-paper';
    els.stepLabel.textContent = 'Tap the broken line';
    els.nudgeBtn.classList.toggle('hidden', run.usedNudge);
  } else if (run.step === 2) {
    els.stepPill.textContent = 'STEP 2';
    els.stepPill.className = 'shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm bg-vermilion text-white';
    els.stepLabel.textContent = puzzle.patch ? 'Patch the broken line' : 'Why does this fail?';
    els.nudgeBtn.classList.add('hidden');
  } else {
    els.stepPill.textContent = 'CLEARED';
    els.stepPill.className = 'shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-sm bg-emerald text-white';
    els.stepLabel.textContent = `Round ${run.roundIndex + 1} Split Locked`;
    els.nudgeBtn.classList.add('hidden');
  }

  els.roundTag.textContent = puzzle.roundTag;
  els.topicTag.textContent = puzzle.topic;
  els.goalText.textContent = puzzle.goal;
  els.codeFilename.textContent = puzzle.filename;

  els.attemptsPips.innerHTML = '';
  for (let i = 0; i < CONFIG.MAX_ATTEMPTS; i++) {
    const spent = i < run.wrongLines.length;
    const dot = document.createElement('span');
    dot.className = spent
      ? 'w-2 h-2 rounded-full border border-inkborder bg-transparent'
      : 'w-2 h-2 rounded-full bg-vermilion';
    els.attemptsPips.appendChild(dot);
  }

  if (run.usedNudge) {
    els.nudgeBox.classList.remove('hidden');
    els.nudgeText.textContent = puzzle.nudge;
  } else {
    els.nudgeBox.classList.add('hidden');
  }

  els.inlineFeedback.classList.add('hidden');

  els.codeLines.innerHTML = '';
  els.codeLines.classList.toggle('code-masked', !run.started);
  els.codeLines.classList.toggle('code-unmasked', run.started);
  els.startOverlay.classList.toggle('hidden', run.started);

  puzzle.lines.forEach((lineText, idx) => {
    const lineNum = idx + 1;
    const isFlaw = lineNum === puzzle.flawLine;
    const isEliminated = run.wrongLines.includes(lineNum);
    const isRevealed = isFlaw && run.step >= 2;
    const isPatching = isFlaw && run.step === 2 && Boolean(puzzle.patch);
    const isInteractive = run.started && run.step === 1 && !isEliminated && lineText.trim() !== '';
    const displayCode = (isFlaw && run.step === 3 && run.patchedCode) ? run.patchedCode : lineText;

    const row = document.createElement(isPatching ? 'div' : 'button');
    if (!isPatching) {
      row.type = 'button';
      row.disabled = !isInteractive;
    }

    let rowClass = 'code-line w-full text-left flex items-stretch focus:outline-none ';
    if (isRevealed) {
      rowClass += run.step === 3
        ? 'bg-emerald-soft border-l-[3px] border-l-emerald'
        : 'bg-vermilion-soft border-l-[3px] border-l-vermilion';
    } else if (isEliminated) {
      rowClass += 'opacity-45 bg-subtle/40 cursor-not-allowed';
    } else if (isInteractive) {
      rowClass += 'interactive cursor-pointer';
    } else {
      rowClass += 'cursor-default';
    }
    row.className = rowClass;

    if (isPatching) {
      const indentMatch = lineText.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : '';
      const initialDraft = run.patchDraft ?? lineText.trim();

      row.innerHTML =
        `<span class="w-9 shrink-0 py-1.5 pr-2.5 text-right font-mono text-[11px] leading-5 select-none border-r border-inkborder/50 text-vermilion font-bold">${lineNum}</span>` +
        `<span class="flex-1 py-1 px-3 flex items-center font-mono text-[12.5px] leading-5">` +
        `<span class="whitespace-pre select-none text-muted">${escapeHtml(indent)}</span>` +
        `<input id="inline-patch-input" type="text" class="patch-input" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" value="${escapeHtml(initialDraft)}" />` +
        `</span>`;
    } else {
      const trapPct = (puzzle.crowdTrapByLine && puzzle.crowdTrapByLine[lineNum]) || 0;
      const heatmapVisible = showHeatmap && run.step === 3 && trapPct > 0;

      row.innerHTML =
        `<span class="w-9 shrink-0 py-1 pr-2.5 text-right font-mono text-[11px] leading-5 select-none border-r border-inkborder/50 ${isRevealed ? (run.step === 3 ? 'text-emerald font-bold' : 'text-vermilion font-bold') : 'text-muted/75'}">${lineNum}</span>` +
        `<span class="relative flex-1 py-1 px-3 font-mono text-[12.5px] sm:text-[13px] leading-5 text-ink overflow-hidden">` +
        (heatmapVisible ? `<span class="absolute inset-y-0 left-0 ${isFlaw ? 'bg-emerald/15' : 'bg-vermilion/15'} pointer-events-none" style="width:${Math.min(100, trapPct)}%"></span>` : '') +
        `<span class="relative z-10 whitespace-pre ${isEliminated ? 'line-through' : ''}">${highlightCode(displayCode, lang)}</span>` +
        `</span>` +
        `<span class="shrink-0 py-1 pr-3 flex items-center">` +
        (heatmapVisible
          ? `<span class="font-mono text-[10px] font-bold ${isFlaw ? 'text-emerald' : 'text-vermilion'}">${trapPct}%</span>`
          : (isRevealed
            ? `<span class="font-mono text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-sm ${run.step === 3 ? 'bg-emerald text-white' : 'bg-vermilion text-white'}">${run.step === 3 ? 'FIXED' : 'BUG'}</span>`
            : (isInteractive ? `<span class="tap-cue font-mono text-[9px] font-bold uppercase text-vermilion">TAP</span>` : ''))) +
        `</span>`;

      if (isInteractive) {
        row.addEventListener('click', () => handleLineTap(lineNum, row));
      }
    }

    els.codeLines.appendChild(row);
  });

  if (run.started && run.step === 2) {
    if (puzzle.patch) {
      els.diagnosisPanel.classList.add('hidden');
      renderPatchPanel(puzzle, run);
    } else {
      els.patchPanel.classList.add('hidden');
      renderDiagnosis(puzzle, run);
    }
  } else {
    els.diagnosisPanel.classList.add('hidden');
    els.patchPanel.classList.add('hidden');
  }

  if (run.started && run.step === 3) {
    renderRoundCleared(puzzle, run);
  } else {
    els.roundClearedPanel.classList.add('hidden');
  }
}

function renderPatchPanel(puzzle, run) {
  els.patchPanel.classList.remove('hidden');
  els.patchTitle.textContent = `Patch Line ${puzzle.flawLine} to fix the bug`;
  els.patchError.classList.add('hidden');

  const inputEl = document.getElementById('inline-patch-input');
  if (!inputEl) return;

  const renderTokens = () => {
    const { word } = getActiveWordBounds(inputEl);
    const ranked = puzzle.patch.tokens.slice().sort((a, b) => {
      const aMatch = word && a.toLowerCase().startsWith(word.toLowerCase()) ? 1 : 0;
      const bMatch = word && b.toLowerCase().startsWith(word.toLowerCase()) ? 1 : 0;
      return bMatch - aMatch;
    });

    els.patchTokens.innerHTML = '';
    ranked.forEach((tok, idx) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      const isTopMatch = idx === 0 && word && tok.toLowerCase().startsWith(word.toLowerCase());
      chip.className = `token-chip${isTopMatch ? ' active' : ''}`;
      chip.textContent = tok;
      chip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        AUDIO.click();
        insertTokenAtCursor(inputEl, tok);
        run.patchDraft = inputEl.value;
        renderTokens();
      });
      els.patchTokens.appendChild(chip);
    });
  };

  inputEl.addEventListener('input', () => {
    run.patchDraft = inputEl.value;
    renderTokens();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const firstChip = els.patchTokens.querySelector('.token-chip');
      if (firstChip) {
        AUDIO.click();
        insertTokenAtCursor(inputEl, firstChip.textContent);
        run.patchDraft = inputEl.value;
        renderTokens();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handlePatchSubmit();
    }
  });

  renderTokens();
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

function handlePatchSubmit() {
  const lang = state.lang;
  const run = getRun(lang);
  const puzzle = PUZZLE_BANK[lang][run.roundIndex];
  const inputEl = document.getElementById('inline-patch-input');
  if (!run.started || run.step !== 2 || !puzzle.patch || !inputEl) return;

  if (isPatchValid(inputEl.value, puzzle.patch)) {
    const indent = (puzzle.lines[puzzle.flawLine - 1].match(/^(\s*)/) || [''])[0];
    run.patchedCode = indent + inputEl.value.trim();
    run.patchDraft = null;
    const clean = run.wrongLines.length === 0 && run.wrongChoices.length === 0 && !run.usedNudge;
    lockRoundSplit(puzzle, run, clean ? 'clean' : 'recovered');
  } else {
    AUDIO.error();
    run.totalMistakes += 1;
    run.totalMs += CONFIG.WRONG_TAP_PENALTY_MS;
    run.roundMs += CONFIG.WRONG_TAP_PENALTY_MS;
    els.stopwatchDisplay.textContent = formatStopwatch(run.totalMs);
    flashPenalty('+3.0s', false);
    saveMistake(puzzle, lang);
    inputEl.classList.add('animate-shake');
    setTimeout(() => inputEl.classList.remove('animate-shake'), 320);
    els.patchError.textContent = 'Patch still fails — +3.0s penalty. Check the tokens above or try again.';
    els.patchError.classList.remove('hidden');
    STORAGE.save(state, currentUser);
  }
}

function renderDiagnosis(puzzle, run) {
  els.diagnosisPanel.classList.remove('hidden');
  els.diagnosisTitle.textContent = `Why does Line ${puzzle.flawLine} break?`;
  els.diagnosisError.classList.add('hidden');
  els.diagnosisChoices.innerHTML = '';

  if (!run.choiceOrders || !Array.isArray(run.choiceOrders[run.roundIndex])) {
    run.choiceOrders = [shuffleIndices(3), shuffleIndices(3), shuffleIndices(3)];
    STORAGE.save(state, currentUser);
  }
  const order = run.choiceOrders[run.roundIndex];
  const orderedChoices = order.map(i => puzzle.choices[i]).filter(Boolean);

  const labels = ['A', 'B', 'C'];
  orderedChoices.forEach((choice, idx) => {
    const isWrong = run.wrongChoices.includes(choice.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.disabled = isWrong;
    btn.className = isWrong
      ? 'w-full text-left px-3 py-2 rounded border border-vermilion-border bg-vermilion-soft/60 opacity-60 flex items-start gap-2.5 cursor-not-allowed'
      : 'w-full text-left px-3 py-2 rounded border border-inkborder bg-surface hover:border-ink/60 hover:bg-paper transition-colors flex items-start gap-2.5 cursor-pointer';
    btn.innerHTML = `
      <span class="shrink-0 w-5 h-5 rounded-sm font-mono text-[11px] font-bold flex items-center justify-center ${isWrong ? 'bg-vermilion text-white' : 'bg-subtle text-ink border border-inkborder'}">${labels[idx]}</span>
      <span class="text-xs sm:text-[13px] text-ink leading-snug">${escapeHtml(choice.text)}</span>
    `;
    if (!isWrong) {
      btn.addEventListener('click', () => handleDiagnosisPick(choice, btn));
    }
    els.diagnosisChoices.appendChild(btn);
  });
}

function renderRoundCleared(puzzle, run) {
  els.roundClearedPanel.classList.remove('hidden');
  const outcome = run.splitOutcomes[run.roundIndex] || 'clean';
  const splitMs = run.splits[run.roundIndex] || run.roundMs;

  els.clearedSplitTime.textContent = (splitMs / 1000).toFixed(2) + 's';
  if (outcome === 'missed') {
    els.clearedBadge.textContent = 'MISSED';
    els.clearedBadge.className = 'rank-stamp px-2 py-0.5 rounded-sm font-mono text-[10px] font-bold uppercase animate-stamp bg-vermilion-soft text-vermilion';
  } else if (outcome === 'recovered') {
    els.clearedBadge.textContent = 'RECOVERED';
    els.clearedBadge.className = 'rank-stamp px-2 py-0.5 rounded-sm font-mono text-[10px] font-bold uppercase animate-stamp bg-amber-soft text-amber';
  } else {
    els.clearedBadge.textContent = 'CLEAN';
    els.clearedBadge.className = 'rank-stamp px-2 py-0.5 rounded-sm font-mono text-[10px] font-bold uppercase animate-stamp bg-emerald-soft text-emerald';
  }

  els.toggleHeatmapLabel.textContent = showHeatmap ? 'Hide Heatmap' : 'Crowd Trap Heatmap';
  els.crowdTrapBanner.classList.toggle('hidden', !showHeatmap);
  els.crowdTrapStat.textContent = puzzle.crowdTrapText || 'Baseline student tap distribution shown above.';
  els.examRuleText.textContent = puzzle.examRule;

  const isLast = run.roundIndex >= PUZZLE_BANK[state.lang].length - 1;
  els.nextRoundBtnText.textContent = isLast ? 'Print Speedrun Receipt' : `Start Round ${run.roundIndex + 2}`;
}

function renderReceipt() {
  const lang = state.lang;
  const record = state.dailyRecords[lang];
  if (!record) return;

  stopClock();
  els.loadingView.classList.add('hidden');
  els.errorView.classList.add('hidden');
  els.gameView.classList.add('hidden');
  els.receiptView.classList.remove('hidden');

  const langObj = CONFIG.LANGUAGES.find(l => l.id === lang) || { label: lang.toUpperCase() };
  els.receiptIssueBadge.textContent = `#${TODAY_ISSUE.issueLabel}`;
  els.receiptLangBadge.textContent = langObj.label.toUpperCase();
  els.receiptFinalTime.textContent = formatStopwatch(record.finalMs);

  if (record.isNewPB) {
    els.receiptPbLine.textContent = 'NEW PERSONAL BEST';
    els.receiptPbLine.className = 'font-mono text-[11px] font-semibold text-emerald mt-1.5';
  } else {
    els.receiptPbLine.textContent = `BEST: ${formatStopwatch(record.pbMs)}`;
    els.receiptPbLine.className = 'font-mono text-[11px] font-semibold text-muted mt-1.5';
  }

  els.receiptRankStamp.textContent = record.rank;
  const stampStyle = record.rank === 'S-RANK'
    ? 'bg-emerald-soft text-emerald'
    : (record.rank === 'A-RANK' ? 'bg-amber-soft text-amber' : 'bg-subtle text-ink');
  els.receiptRankStamp.className = `rank-stamp px-3.5 py-2 rounded-sm font-mono text-sm font-bold uppercase text-center animate-stamp ${stampStyle}`;

  els.receiptSplitsGrid.innerHTML = '';
  const splitLabels = ['R1 • Warm-Up', 'R2 • Core', 'R3 • Boss'];
  const outcomes = record.splitOutcomes || ['clean', 'clean', 'clean'];
  record.splits.forEach((ms, idx) => {
    const outcome = outcomes[idx];
    const colorClass = outcome === 'missed'
      ? 'border-vermilion-border bg-vermilion-soft/60 text-vermilion'
      : (outcome === 'recovered'
        ? 'border-amber-border bg-amber-soft/60 text-amber'
        : 'border-emerald-border bg-emerald-soft/60 text-emerald');
    const box = document.createElement('div');
    box.className = `p-2.5 rounded-sm border ${colorClass} text-center`;
    box.innerHTML = `
      <div class="font-mono text-[9px] uppercase tracking-wider opacity-80">${splitLabels[idx]}</div>
      <div class="font-mono text-sm font-bold tabular-nums mt-1">${formatSplitShort(ms || 0)}</div>
    `;
    els.receiptSplitsGrid.appendChild(box);
  });

  const rankName = getCareerRank(state.xp);
  els.receiptCareerRank.textContent = rankName;
  els.receiptXpGain.textContent = record.lastXpGain > 0 ? `+${record.lastXpGain} XP` : 'PB Run';
  els.receiptStreak.textContent = `${state.streak} ${state.streak === 1 ? 'Day' : 'Days'}`;

  const currentIdx = CONFIG.CAREER_RANKS.findIndex(r => r.name === rankName);
  const currentTier = CONFIG.CAREER_RANKS[currentIdx] || CONFIG.CAREER_RANKS[0];
  const nextTier = CONFIG.CAREER_RANKS[currentIdx + 1];

  if (nextTier) {
    const pct = Math.min(100, Math.max(5, Math.round(((state.xp - currentTier.minXP) / (nextTier.minXP - currentTier.minXP)) * 100)));
    els.receiptCareerBar.style.width = `${pct}%`;
    els.receiptCareerProgressLabel.textContent = `${state.xp} / ${nextTier.minXP} XP`;
    els.receiptCareerNextLabel.textContent = `Next: ${nextTier.name}`;
  } else {
    els.receiptCareerBar.style.width = '100%';
    els.receiptCareerProgressLabel.textContent = `${state.xp} XP`;
    els.receiptCareerNextLabel.textContent = 'Max Rank Reached';
  }

  const nextLang = CONFIG.LANGUAGES.find(l => l.id !== lang && !(state.dailyRecords[l.id] && state.dailyRecords[l.id].completed))
    || CONFIG.LANGUAGES[(CONFIG.LANGUAGES.findIndex(l => l.id === lang) + 1) % CONFIG.LANGUAGES.length];
  els.suggestedLangName.textContent = nextLang.label;
  els.suggestedLangBtn.dataset.lang = nextLang.id;

  els.copyReceiptText.textContent = 'Copy Share Grid';

  updateMidnightCountdown();
  if (!countdownInterval) {
    countdownInterval = setInterval(updateMidnightCountdown, 1000);
  }
}

function renderMistakesDrawer() {
  els.mistakesList.innerHTML = '';
  if (!state.mistakes.length) {
    els.mistakesList.innerHTML = `
      <div class="rounded border border-inkborder bg-paper/60 p-6 text-center space-y-2">
        <div class="font-mono text-xs font-bold uppercase tracking-wider text-emerald">Clean Sheet</div>
        <p class="text-xs text-muted leading-relaxed">
          Any bug you miss or use a Nudge on is automatically saved here as a quick pre-exam cheat sheet.
        </p>
      </div>
    `;
    return;
  }

  state.mistakes.forEach((m) => {
    const card = document.createElement('article');
    card.className = 'rounded border border-inkborder bg-paper/50 p-3.5 space-y-2';
    card.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <span class="font-mono text-[10px] font-bold uppercase text-vermilion">${escapeHtml(m.langLabel)} • ${escapeHtml(m.topic)}</span>
        <span class="font-mono text-[10px] text-muted">${escapeHtml(m.filename)}</span>
      </div>
      <p class="text-xs font-semibold text-ink leading-snug">${escapeHtml(m.goal)}</p>
      <div class="px-2.5 py-1.5 rounded bg-surface border border-vermilion-border font-mono text-[11px] text-ink overflow-x-auto whitespace-pre">L${m.flawLine}: ${escapeHtml(m.flawCode)}</div>
      <p class="text-[11.5px] text-muted leading-relaxed">${escapeHtml(m.examRule)}</p>
      <div class="pt-1 flex justify-end">
        <button type="button" class="mark-mastered-btn px-2.5 py-1 rounded border border-inkborder bg-surface text-[11px] font-bold text-emerald hover:border-emerald cursor-pointer">
          Mark Mastered ✓
        </button>
      </div>
    `;
    card.querySelector('.mark-mastered-btn').addEventListener('click', () => {
      AUDIO.click();
      state.mistakes = state.mistakes.filter(item => item.id !== m.id);
      STORAGE.save(state, currentUser);
      renderMistakeBadge();
      renderMistakesDrawer();
    });
    els.mistakesList.appendChild(card);
  });
}

function startDailyRun() {
  const run = getRun(state.lang);
  if (run.started) return;
  AUDIO.click();
  run.started = true;
  trackEvent('run_started', { lang: state.lang, issue: TODAY_ISSUE.issueNum, practice: run.isPractice });
  STORAGE.save(state, currentUser);
  renderHud();
  renderGame();
  startClock();
}

function handleLineTap(lineNum, rowEl) {
  const lang = state.lang;
  const run = getRun(lang);
  const puzzle = PUZZLE_BANK[lang][run.roundIndex];
  if (!run.started || run.step !== 1) return;

  if (lineNum === puzzle.flawLine) {
    AUDIO.click();
    run.step = 2;
    STORAGE.save(state, currentUser);
    renderHud();
    renderGame();
    return;
  }

  AUDIO.error();
  run.wrongLines.push(lineNum);
  run.totalMistakes += 1;
  run.totalMs += CONFIG.WRONG_TAP_PENALTY_MS;
  run.roundMs += CONFIG.WRONG_TAP_PENALTY_MS;
  els.stopwatchDisplay.textContent = formatStopwatch(run.totalMs);
  flashPenalty('+3.0s', false);
  saveMistake(puzzle, lang);

  if (rowEl) rowEl.classList.add('animate-shake');

  if (run.wrongLines.length >= CONFIG.MAX_ATTEMPTS) {
    lockRoundSplit(puzzle, run, 'missed');
    return;
  }

  STORAGE.save(state, currentUser);
  renderGame();
  const left = CONFIG.MAX_ATTEMPTS - run.wrongLines.length;
  els.inlineFeedbackText.textContent = `Line ${lineNum} is valid — tap another line (${left} ${left === 1 ? 'attempt' : 'attempts'} left).`;
  els.inlineFeedback.classList.remove('hidden');
}

function handleDiagnosisPick(choice, btnEl) {
  const lang = state.lang;
  const run = getRun(lang);
  const puzzle = PUZZLE_BANK[lang][run.roundIndex];
  if (!run.started || run.step !== 2) return;

  if (choice.correct) {
    const clean = run.wrongLines.length === 0 && run.wrongChoices.length === 0 && !run.usedNudge;
    lockRoundSplit(puzzle, run, clean ? 'clean' : 'recovered');
  } else {
    AUDIO.error();
    run.wrongChoices.push(choice.id);
    run.totalMistakes += 1;
    run.totalMs += CONFIG.WRONG_TAP_PENALTY_MS;
    run.roundMs += CONFIG.WRONG_TAP_PENALTY_MS;
    els.stopwatchDisplay.textContent = formatStopwatch(run.totalMs);
    flashPenalty('+3.0s', false);
    saveMistake(puzzle, lang);

    if (btnEl) btnEl.classList.add('animate-shake');
    STORAGE.save(state, currentUser);
    renderDiagnosis(puzzle, run);
    els.diagnosisError.textContent = 'Not quite — +3.0s penalty. Check the exact failure mode.';
    els.diagnosisError.classList.remove('hidden');
  }
}

function lockRoundSplit(puzzle, run, outcome) {
  stopClock();
  if (outcome === 'missed') {
    AUDIO.error();
  } else {
    AUDIO.split();
  }
  run.step = 3;
  run.splits[run.roundIndex] = run.roundMs;
  run.splitOutcomes[run.roundIndex] = outcome;
  showHeatmap = false;
  STORAGE.save(state, currentUser);
  renderHud();
  renderGame();
}

function handleNextRound() {
  const lang = state.lang;
  const run = getRun(lang);
  if (run.step !== 3) return;

  AUDIO.click();
  const totalRounds = PUZZLE_BANK[lang].length;
  if (run.roundIndex < totalRounds - 1) {
    run.roundIndex += 1;
    run.step = 1;
    run.roundMs = 0;
    run.wrongLines = [];
    run.wrongChoices = [];
    run.patchDraft = null;
    run.patchedCode = null;
    run.usedNudge = false;
    showHeatmap = false;
    STORAGE.save(state, currentUser);
    renderHud();
    renderGame();
    startClock();
  } else {
    completeDailyRun();
  }
}

function completeDailyRun() {
  stopClock();
  AUDIO.finish();

  const lang = state.lang;
  const run = getRun(lang);
  const prev = state.dailyRecords[lang];
  const rank = computeSpeedrunRank(run.totalMs, run.totalMistakes, run.totalNudges);

  let xpGain = 0;
  if (!run.isPractice && !(prev && prev.completed)) {
    xpGain = rank === 'S-RANK' ? 180 : (rank === 'A-RANK' ? 140 : (rank === 'B-RANK' ? 110 : 80));
    state.xp += xpGain;
    if (state.lastCompletedDate !== TODAY_ISSUE.dateKey) {
      state.streak = state.lastCompletedDate === getYesterdayDateKey() ? state.streak + 1 : 1;
      state.lastCompletedDate = TODAY_ISSUE.dateKey;
    }
  }

  const prevPb = prev && typeof prev.pbMs === 'number' ? prev.pbMs : Infinity;
  const isNewPB = run.totalMs < prevPb;

  state.dailyRecords[lang] = {
    completed: true,
    finalMs: run.totalMs,
    splits: run.splits.slice(),
    splitOutcomes: run.splitOutcomes.slice(),
    rank,
    pbMs: isNewPB ? run.totalMs : prevPb,
    isNewPB,
    lastXpGain: xpGain
  };

  trackEvent('run_completed', {
    lang,
    rank,
    finalSec: Math.round(run.totalMs / 100) / 10,
    practice: run.isPractice
  });

  run.isPractice = false;
  STORAGE.save(state, currentUser);
  renderHud();
  renderReceipt();
}

function handleNudge() {
  const lang = state.lang;
  const run = getRun(lang);
  const puzzle = PUZZLE_BANK[lang][run.roundIndex];
  if (!run.started || run.step !== 1 || run.usedNudge) return;

  AUDIO.click();
  run.usedNudge = true;
  run.totalNudges += 1;
  run.totalMs += CONFIG.NUDGE_PENALTY_MS;
  run.roundMs += CONFIG.NUDGE_PENALTY_MS;
  els.stopwatchDisplay.textContent = formatStopwatch(run.totalMs);
  flashPenalty('+5.0s', true);
  saveMistake(puzzle, lang);
  STORAGE.save(state, currentUser);
  renderGame();
}

async function loadLanguageView() {
  stopClock();
  showHeatmap = false;
  renderHud();

  els.gameView.classList.add('hidden');
  els.receiptView.classList.add('hidden');
  els.errorView.classList.add('hidden');
  els.loadingView.classList.remove('hidden');

  const start = performance.now();
  try {
    await ensurePuzzlesLoaded();
  } catch (err) {
    console.error('[REDLINE] Failed to load puzzles:', err);
    els.loadingView.classList.add('hidden');
    els.errorMessage.textContent = 'Could not load puzzles.json. Check your connection or local server and retry.';
    els.errorView.classList.remove('hidden');
    return;
  }

  const remainingDelay = Math.max(0, CONFIG.SKELETON_DELAY_MS - (performance.now() - start));
  setTimeout(() => {
    const lang = state.lang;
    const record = state.dailyRecords[lang];
    const run = getRun(lang);

    if (!PUZZLE_BANK || !PUZZLE_BANK[lang] || !PUZZLE_BANK[lang].length) {
      els.loadingView.classList.add('hidden');
      els.errorView.classList.remove('hidden');
      return;
    }

    renderHud();
    if (record && record.completed && !run.isPractice) {
      renderReceipt();
    } else {
      renderGame();
      if (run.started && run.step < 3) startClock();
    }
  }, remainingDelay);
}

// Event Listeners
els.startRunBtn.addEventListener('click', startDailyRun);
els.nudgeBtn.addEventListener('click', handleNudge);
els.patchSubmitBtn.addEventListener('click', handlePatchSubmit);

els.patchResetBtn.addEventListener('click', () => {
  const run = getRun(state.lang);
  const puzzle = PUZZLE_BANK[state.lang][run.roundIndex];
  const inputEl = document.getElementById('inline-patch-input');
  if (!inputEl || !puzzle) return;
  AUDIO.click();
  inputEl.value = puzzle.lines[puzzle.flawLine - 1].trim();
  run.patchDraft = inputEl.value;
  inputEl.focus();
});

els.toggleHeatmapBtn.addEventListener('click', () => {
  AUDIO.click();
  showHeatmap = !showHeatmap;
  renderGame();
});

els.nextRoundBtn.addEventListener('click', handleNextRound);

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('execCommand failed');
}

els.copyReceiptBtn.addEventListener('click', async () => {
  const lang = state.lang;
  const record = state.dailyRecords[lang];
  if (!record) return;
  AUDIO.click();

  const langLabel = (CONFIG.LANGUAGES.find(l => l.id === lang) || { label: lang }).label;
  const outcomes = record.splitOutcomes || ['clean', 'clean', 'clean'];
  const blocks = outcomes.map(o => (o === 'missed' ? '🟥' : (o === 'recovered' ? '🟨' : '🟩'))).join('');
  const splitsStr = record.splits.map((ms, i) => `R${i + 1} ${formatSplitShort(ms || 0)}`).join(' · ');
  const shareText = `REDLINE #${TODAY_ISSUE.issueLabel} (${langLabel})\n${blocks} ${formatStopwatch(record.finalMs)} · ${record.rank}\n${splitsStr}\n${CONFIG.SHARE_URL}`;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(shareText);
    } else {
      fallbackCopy(shareText);
    }
    trackEvent('receipt_copied', { lang, rank: record.rank });
    els.copyReceiptText.textContent = 'Copied to Clipboard ✓';
    setTimeout(() => { els.copyReceiptText.textContent = 'Copy Share Grid'; }, 2000);
  } catch (err) {
    try {
      fallbackCopy(shareText);
      els.copyReceiptText.textContent = 'Copied to Clipboard ✓';
      setTimeout(() => { els.copyReceiptText.textContent = 'Copy Share Grid'; }, 2000);
    } catch (e2) {
      els.copyReceiptText.textContent = 'Copy unavailable';
    }
  }
});

els.replayPbBtn.addEventListener('click', () => {
  AUDIO.click();
  state.activeRuns[state.lang] = createFreshRun(true);
  STORAGE.save(state, currentUser);
  loadLanguageView();
});

els.suggestedLangBtn.addEventListener('click', () => {
  const nextId = els.suggestedLangBtn.dataset.lang;
  if (!nextId) return;
  AUDIO.click();
  state.lang = nextId;
  STORAGE.save(state, currentUser);
  loadLanguageView();
});

els.retryLoadBtn.addEventListener('click', () => {
  AUDIO.click();
  PUZZLE_BANK = null;
  loadLanguageView();
});

els.themeToggle.addEventListener('click', () => {
  AUDIO.click();
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  STORAGE.save(state, currentUser);
  applyTheme();
});

els.soundToggle.addEventListener('click', () => {
  state.soundEnabled = !state.soundEnabled;
  AUDIO.enabled = state.soundEnabled;
  if (AUDIO.enabled) AUDIO.click();
  STORAGE.save(state, currentUser);
  renderSoundIcon();
});

els.mistakesBtn.addEventListener('click', () => {
  AUDIO.click();
  renderMistakesDrawer();
  els.mistakesDrawerBackdrop.classList.remove('hidden');
});

els.closeMistakesBtn.addEventListener('click', () => {
  AUDIO.click();
  els.mistakesDrawerBackdrop.classList.add('hidden');
});

els.mistakesDrawerBackdrop.addEventListener('click', (e) => {
  if (e.target === els.mistakesDrawerBackdrop) {
    els.mistakesDrawerBackdrop.classList.add('hidden');
  }
});

function openPassModal() {
  AUDIO.click();
  trackEvent('pass_modal_opened', { lang: state.lang });
  if (CONFIG.CHECKOUT_URL) {
    els.checkoutBtn.textContent = 'Join Early Access (50% Off)';
    els.waitlistForm.classList.add('hidden');
    els.waitlistSuccess.classList.add('hidden');
  } else if (state.waitlistEmail) {
    els.checkoutBtn.textContent = 'On Early Access List ✓';
    els.waitlistForm.classList.add('hidden');
    els.waitlistSuccess.classList.remove('hidden');
  } else {
    els.checkoutBtn.textContent = 'Join Early Access';
    els.waitlistForm.classList.add('hidden');
    els.waitlistSuccess.classList.add('hidden');
  }
  els.passModal.classList.remove('hidden');
}

els.headerPassBtn.addEventListener('click', openPassModal);
els.openPassBtn.addEventListener('click', openPassModal);

els.closePassBtn.addEventListener('click', () => {
  AUDIO.click();
  els.passModal.classList.add('hidden');
});

els.passModal.addEventListener('click', (e) => {
  if (e.target === els.passModal) els.passModal.classList.add('hidden');
});

els.checkoutBtn.addEventListener('click', () => {
  AUDIO.click();
  trackEvent('early_access_clicked', { hasUrl: Boolean(CONFIG.CHECKOUT_URL) });
  if (CONFIG.CHECKOUT_URL) {
    window.open(CONFIG.CHECKOUT_URL, '_blank', 'noopener,noreferrer');
    return;
  }
  if (state.waitlistEmail) {
    els.waitlistSuccess.classList.remove('hidden');
    return;
  }
  els.waitlistForm.classList.remove('hidden');
  els.waitlistEmail.focus();
});

els.waitlistForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const email = els.waitlistEmail.value.trim();
  if (!email) return;
  AUDIO.split();
  state.waitlistEmail = email;
  trackEvent('waitlist_submitted');
  STORAGE.save(state, currentUser);
  els.waitlistForm.classList.add('hidden');
  els.checkoutBtn.textContent = 'On Early Access List ✓';
  els.waitlistSuccess.classList.remove('hidden');
});

els.resetProgressBtn.addEventListener('click', () => {
  AUDIO.click();
  const defaultLabel = currentUser ? 'Reset Cloud Progress' : 'Reset Local Progress';
  if (!resetArmed) {
    resetArmed = true;
    els.resetProgressBtn.textContent = 'Click Again to Confirm Reset';
    resetTimeout = setTimeout(() => {
      resetArmed = false;
      els.resetProgressBtn.textContent = defaultLabel;
    }, 3000);
    return;
  }
  clearTimeout(resetTimeout);
  resetArmed = false;
  els.resetProgressBtn.textContent = defaultLabel;
  state = STORAGE.getDefault();
  if (currentUser) {
    STORAGE.save(state, currentUser);
  } else {
    localStorage.removeItem(CONFIG.STORAGE_KEY);
  }
  AUDIO.enabled = state.soundEnabled;
  loadLanguageView();
});

// Auth Modal & Session Sync
const authEls = {
  btn: document.getElementById('auth-btn'),
  dot: document.getElementById('auth-dot'),
  btnLabel: document.getElementById('auth-btn-label'),
  modal: document.getElementById('auth-modal'),
  closeBtn: document.getElementById('close-auth-btn'),
  title: document.getElementById('auth-modal-title'),
  loggedOutView: document.getElementById('auth-logged-out-view'),
  loggedInView: document.getElementById('auth-logged-in-view'),
  tabSignin: document.getElementById('auth-tab-signin'),
  tabSignup: document.getElementById('auth-tab-signup'),
  freshNotice: document.getElementById('auth-fresh-notice'),
  form: document.getElementById('auth-form'),
  email: document.getElementById('auth-email'),
  password: document.getElementById('auth-password'),
  error: document.getElementById('auth-error'),
  success: document.getElementById('auth-success'),
  submitBtn: document.getElementById('auth-submit-btn'),
  userEmail: document.getElementById('auth-user-email'),
  passStatus: document.getElementById('auth-pass-status'),
  upgradeBtn: document.getElementById('auth-upgrade-btn'),
  signoutBtn: document.getElementById('auth-signout-btn')
};

let authMode = 'signin';

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === 'signup';
  authEls.title.textContent = isSignup ? 'Create Account' : 'Sign In';
  authEls.submitBtn.textContent = isSignup ? 'Create Account' : 'Sign In';
  authEls.freshNotice.classList.toggle('hidden', !isSignup);
  authEls.error.classList.add('hidden');
  authEls.success.classList.add('hidden');

  authEls.tabSignin.className = !isSignup
    ? 'py-1.5 rounded-sm font-mono text-[11px] font-bold bg-surface text-ink border border-inkborder cursor-pointer'
    : 'py-1.5 rounded-sm font-mono text-[11px] font-semibold text-muted hover:text-ink cursor-pointer';
  authEls.tabSignup.className = isSignup
    ? 'py-1.5 rounded-sm font-mono text-[11px] font-bold bg-surface text-ink border border-inkborder cursor-pointer'
    : 'py-1.5 rounded-sm font-mono text-[11px] font-semibold text-muted hover:text-ink cursor-pointer';
}

function updateAuthUI() {
  if (currentUser) {
    authEls.dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald';
    authEls.btnLabel.textContent = 'Account';
    authEls.title.textContent = 'Account';
    authEls.loggedOutView.classList.add('hidden');
    authEls.loggedInView.classList.remove('hidden');
    authEls.userEmail.textContent = currentUser.email;
    authEls.passStatus.textContent = hasActivePass ? 'Active (30-Day Pass)' : 'Free Tier';
    els.resetProgressBtn.textContent = 'Reset Cloud Progress';
  } else {
    authEls.dot.className = 'w-1.5 h-1.5 rounded-full bg-muted';
    authEls.btnLabel.textContent = 'Sign In';
    authEls.loggedInView.classList.add('hidden');
    authEls.loggedOutView.classList.remove('hidden');
    setAuthMode(authMode);
    els.resetProgressBtn.textContent = 'Reset Local Progress';
  }
}

authEls.btn.addEventListener('click', () => {
  AUDIO.click();
  updateAuthUI();
  authEls.modal.classList.remove('hidden');
});

authEls.closeBtn.addEventListener('click', () => {
  AUDIO.click();
  authEls.modal.classList.add('hidden');
});

authEls.modal.addEventListener('click', (e) => {
  if (e.target === authEls.modal) authEls.modal.classList.add('hidden');
});

authEls.tabSignin.addEventListener('click', () => { AUDIO.click(); setAuthMode('signin'); });
authEls.tabSignup.addEventListener('click', () => { AUDIO.click(); setAuthMode('signup'); });

authEls.upgradeBtn.addEventListener('click', () => {
  authEls.modal.classList.add('hidden');
  openPassModal();
});

authEls.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!sb) {
    authEls.error.textContent = 'Supabase keys are not configured yet.';
    authEls.error.classList.remove('hidden');
    return;
  }

  authEls.error.classList.add('hidden');
  authEls.success.classList.add('hidden');
  authEls.submitBtn.disabled = true;
  authEls.submitBtn.textContent = authMode === 'signup' ? 'Creating...' : 'Signing in...';

  const email = authEls.email.value.trim();
  const password = authEls.password.value;

  const { data, error } = authMode === 'signup'
    ? await sb.auth.signUp({ email, password })
    : await sb.auth.signInWithPassword({ email, password });

  authEls.submitBtn.disabled = false;
  authEls.submitBtn.textContent = authMode === 'signup' ? 'Create Account' : 'Sign In';

  if (error) {
    AUDIO.error();
    authEls.error.textContent = error.message;
    authEls.error.classList.remove('hidden');
    return;
  }

  if (authMode === 'signup' && !data.session) {
    AUDIO.split();
    authEls.success.textContent = 'Check your email to confirm your account, then sign in.';
    authEls.success.classList.remove('hidden');
    return;
  }

  AUDIO.split();
  authEls.form.reset();
  authEls.modal.classList.add('hidden');
});

authEls.signoutBtn.addEventListener('click', async () => {
  if (!sb) return;
  AUDIO.click();
  await sb.auth.signOut();
  authEls.modal.classList.add('hidden');
});

if (sb) {
  sb.auth.onAuthStateChange(async (_event, session) => {
    const nextUser = session ? session.user : null;
    const changed = (nextUser?.id || null) !== (currentUser?.id || null);
    currentUser = nextUser;

    if (changed) {
      stopClock();
      if (currentUser) {
        const res = await STORAGE.loadCloud(currentUser.id, {
          theme: state.theme,
          soundEnabled: state.soundEnabled
        });
        state = res.state;
        hasActivePass = res.hasActivePass;
      } else {
        hasActivePass = false;
        state = STORAGE.loadLocal();
      }
      AUDIO.enabled = state.soundEnabled;
      updateAuthUI();
      loadLanguageView();
    } else {
      updateAuthUI();
    }
  });
}

window.addEventListener('online', renderOfflineState);
window.addEventListener('offline', renderOfflineState);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    els.mistakesDrawerBackdrop.classList.add('hidden');
    els.passModal.classList.add('hidden');
    authEls.modal.classList.add('hidden');
    return;
  }
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    return;
  }
  if (
    !els.mistakesDrawerBackdrop.classList.contains('hidden') ||
    !els.passModal.classList.contains('hidden') ||
    !authEls.modal.classList.contains('hidden')
  ) {
    return;
  }
  if (els.gameView.classList.contains('hidden')) return;

  const run = getRun(state.lang);
  const key = e.key.toLowerCase();

  if (!run.started) {
    if (key === 'enter' || e.code === 'Space') {
      e.preventDefault();
      startDailyRun();
    }
    return;
  }

  if (run.step === 1) {
    if (key === 'h') {
      handleNudge();
      return;
    }
    const num = parseInt(key, 10);
    if (num >= 1 && num <= 9) {
      const btns = els.codeLines.querySelectorAll('button');
      if (btns[num - 1] && !btns[num - 1].disabled) {
        btns[num - 1].click();
      }
    }
  } else if (run.step === 2) {
    const map = { a: 0, b: 1, c: 2 };
    if (key in map) {
      const btns = els.diagnosisChoices.querySelectorAll('button');
      if (btns[map[key]] && !btns[map[key]].disabled) {
        btns[map[key]].click();
      }
    }
  } else if (run.step === 3 && (key === 'enter' || e.code === 'Space')) {
    e.preventDefault();
    els.nextRoundBtn.click();
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

loadLanguageView();