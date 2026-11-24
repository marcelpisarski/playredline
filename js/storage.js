import { CONFIG, TODAY_ISSUE } from './config.js';

const isSupabaseConfigured = Boolean(
  window.supabase &&
  CONFIG.SUPABASE_URL.startsWith('https://') &&
  CONFIG.SUPABASE_PUBLISHABLE_KEY
);

export const sb = isSupabaseConfigured
  ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY)
  : null;

let cloudSaveTimer = null;

export const STORAGE = {
  getDefault() {
    return {
      theme: 'light',
      soundEnabled: true,
      lang: 'python',
      xp: 0,
      streak: 0,
      issueDate: TODAY_ISSUE.dateKey,
      lastCompletedDate: null,
      waitlistEmail: null,
      mistakes: [],
      dailyRecords: {},
      activeRuns: {}
    };
  },

  normalize(rawObj) {
    const merged = Object.assign(this.getDefault(), rawObj || {});
    if (merged.issueDate !== TODAY_ISSUE.dateKey) {
      merged.issueDate = TODAY_ISSUE.dateKey;
      merged.dailyRecords = {};
      merged.activeRuns = {};
    }
    return merged;
  },

  loadLocal() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      return raw ? this.normalize(JSON.parse(raw)) : this.getDefault();
    } catch (err) {
      return this.getDefault();
    }
  },

  async loadCloud(userId, fallbackPrefs = {}) {
    if (!sb) return { state: this.getDefault(), hasActivePass: false };

    const { data, error } = await sb
      .from('user_profiles')
      .select('game_state, exam_pass_until')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('[REDLINE] Cloud load failed:', error);
      return { state: this.getDefault(), hasActivePass: false };
    }

    if (!data) {
      const fresh = this.getDefault();
      if (fallbackPrefs.theme) fresh.theme = fallbackPrefs.theme;
      if (typeof fallbackPrefs.soundEnabled === 'boolean') {
        fresh.soundEnabled = fallbackPrefs.soundEnabled;
      }
      const { error: insertErr } = await sb
        .from('user_profiles')
        .insert({ id: userId, game_state: fresh });
      if (insertErr) console.error('[REDLINE] Profile init failed:', insertErr);
      return { state: fresh, hasActivePass: false };
    }

    const hasActivePass = Boolean(
      data.exam_pass_until && new Date(data.exam_pass_until) > new Date()
    );
    return { state: this.normalize(data.game_state), hasActivePass };
  },

  save(data, currentUser = null) {
    if (currentUser && sb) {
      clearTimeout(cloudSaveTimer);
      cloudSaveTimer = setTimeout(async () => {
        const { error } = await sb
          .from('user_profiles')
          .update({ game_state: data, updated_at: new Date().toISOString() })
          .eq('id', currentUser.id);
        if (error) console.error('[REDLINE] Cloud save failed:', error);
      }, 350);
    } else {
      try {
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
      } catch (err) {}
    }
  }
};