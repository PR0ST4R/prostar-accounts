// =====================================================================
// PROSTAR ACCOUNTS — Shared client logic
// Include this on every page via:
//   <script src="https://unpkg.com/@supabase/supabase-js@2"></script>
//   <script src="/assets/prostar-client.js"></script>
// =====================================================================

// ---- CONFIG: replace with your real Supabase project values ----
const PROSTAR_SUPABASE_URL = 'https://agechujhqhbmuenncwtb.supabase.co';
const PROSTAR_SUPABASE_ANON_KEY = 'sb_publishable_HbCn6NL--T-Q6556_l0SIw_7QBgMUx3';

const prostarSupabase = window.supabase.createClient(
  PROSTAR_SUPABASE_URL,
  PROSTAR_SUPABASE_ANON_KEY,
  {
    auth: {
      // We manage multi-account sessions ourselves (see below), so we
      // don't want Supabase's default single-session persistence
      // fighting with it.
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'prostar-active-session'
    }
  }
);

// ---------------------------------------------------------------------
// MULTI-ACCOUNT SESSION STORE
//
// Supabase's client only ever holds ONE active session at a time. To
// support multiple logged-in Prostar accounts on one device (like
// Google's account switcher), we keep our own registry of sessions in
// localStorage, keyed by user id, and swap the active Supabase session
// in/out of that registry as the user switches accounts.
// ---------------------------------------------------------------------

const PROSTAR_ACCOUNTS_KEY = 'prostar-known-accounts';

function prostarGetKnownAccounts() {
  try {
    const raw = localStorage.getItem(PROSTAR_ACCOUNTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to read known Prostar accounts', e);
    return [];
  }
}

function prostarSaveKnownAccounts(accounts) {
  localStorage.setItem(PROSTAR_ACCOUNTS_KEY, JSON.stringify(accounts));
}

// Call this right after a successful sign-in to remember the account
// locally (session tokens + basic profile info for quick switching).
function prostarRememberAccount({ userId, email, displayName, avatarUrl, session }) {
  const accounts = prostarGetKnownAccounts();
  const existingIndex = accounts.findIndex(a => a.userId === userId);
  const entry = {
    userId,
    email,
    displayName: displayName || email.split('@')[0],
    avatarUrl: avatarUrl || null,
    refreshToken: session.refresh_token,
    lastActive: Date.now()
  };
  if (existingIndex >= 0) {
    accounts[existingIndex] = entry;
  } else {
    accounts.push(entry);
  }
  prostarSaveKnownAccounts(accounts);
  localStorage.setItem('prostar-active-user-id', userId);
}

function prostarForgetAccount(userId) {
  const accounts = prostarGetKnownAccounts().filter(a => a.userId !== userId);
  prostarSaveKnownAccounts(accounts);
  if (localStorage.getItem('prostar-active-user-id') === userId) {
    localStorage.removeItem('prostar-active-user-id');
  }
}

function prostarGetActiveUserId() {
  return localStorage.getItem('prostar-active-user-id');
}

// Switch the live Supabase session to a different known account using
// its stored refresh token. Returns the new session, or null on failure
// (e.g. the refresh token expired — in which case that account needs
// to sign in again).
async function prostarSwitchAccount(userId) {
  const accounts = prostarGetKnownAccounts();
  const account = accounts.find(a => a.userId === userId);
  if (!account) return null;

  const { data, error } = await prostarSupabase.auth.refreshSession({
    refresh_token: account.refreshToken
  });

  if (error || !data.session) {
    console.error('Could not switch to account', userId, error);
    return null;
  }

  // Update stored refresh token (it rotates on use) and mark active
  prostarRememberAccount({
    userId: account.userId,
    email: account.email,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    session: data.session
  });

  return data.session;
}

// ---------------------------------------------------------------------
// EMAIL OTP SIGN-IN
// ---------------------------------------------------------------------

async function prostarSendOtp(email) {
  const { error } = await prostarSupabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true }
  });
  return { error };
}

async function prostarVerifyOtp(email, token) {
  const { data, error } = await prostarSupabase.auth.verifyOtp({
    email,
    token,
    type: 'email'
  });
  return { data, error };
}

// After verifying OTP, fetch/create the prostar_profiles row and
// remember this account in the local multi-account store.
async function prostarFinalizeLogin(session) {
  const userId = session.user.id;
  const email = session.user.email;

  let { data: profile } = await prostarSupabase
    .from('prostar_profiles')
    .select('*')
    .eq('id', userId)
    .single();

  // Profile is normally auto-created by the DB trigger, but guard
  // against a race condition on first-ever login.
  if (!profile) {
    await new Promise(r => setTimeout(r, 500));
    const retry = await prostarSupabase
      .from('prostar_profiles')
      .select('*')
      .eq('id', userId)
      .single();
    profile = retry.data;
  }

  prostarRememberAccount({
    userId,
    email,
    displayName: profile?.display_name || email.split('@')[0],
    avatarUrl: profile?.avatar_url || null,
    session
  });

  return profile;
}

// ---------------------------------------------------------------------
// SIGN OUT
// ---------------------------------------------------------------------

async function prostarSignOutCurrent() {
  const userId = prostarGetActiveUserId();
  await prostarSupabase.auth.signOut();
  if (userId) prostarForgetAccount(userId);
}

async function prostarSignOutAll() {
  await prostarSupabase.auth.signOut();
  localStorage.removeItem(PROSTAR_ACCOUNTS_KEY);
  localStorage.removeItem('prostar-active-user-id');
}

// ---------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------

function prostarQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function prostarInitials(name) {
  if (!name) return '?';
  return name.trim().charAt(0).toUpperCase();
}

// Small deterministic color for avatar fallbacks, based on user id.
function prostarAvatarColor(seed) {
  const colors = ['#2FD1A3', '#5B8DEF', '#E8615A', '#E8B84B', '#B674E8', '#4BC0E8'];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}