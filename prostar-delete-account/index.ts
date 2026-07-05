// =====================================================================
// PROSTAR ACCOUNTS — Edge Function: prostar-delete-account
//
// Called from the dashboard's "Delete account" flow, AFTER the browser
// has already re-verified the user's identity (password check or OTP
// verification) and had them retype their email as confirmation.
//
// This function re-checks the caller's access token server-side (never
// trusts the browser alone) and then permanently deletes the auth user,
// which cascades to prostar_profiles, prostar_oauth_approvals, and
// prostar_oauth_codes via the existing "on delete cascade" foreign keys.
//
// Deploy with:
//   supabase functions deploy prostar-delete-account
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const accessToken = authHeader.replace('Bearer ', '');
    if (!accessToken) {
      return json({ error: 'missing_authorization' }, 401);
    }

    const { confirm_email } = await req.json();
    if (!confirm_email) {
      return json({ error: 'missing_confirmation' }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Re-verify the session server-side. This is the real security
    // boundary — the browser cannot forge this.
    const { data: userData, error: userError } = await admin.auth.getUser(accessToken);
    if (userError || !userData?.user) {
      return json({ error: 'invalid_session' }, 401);
    }

    const user = userData.user;

    // Double-check the retyped email actually matches this account,
    // server-side (never trust a client-side string comparison alone).
    if (confirm_email.trim().toLowerCase() !== user.email.toLowerCase()) {
      return json({ error: 'email_mismatch' }, 400);
    }

    // Delete the auth user. FK cascades handle prostar_profiles,
    // prostar_oauth_approvals, and any prostar_oauth_codes tied to them.
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteError) {
      console.error('Failed to delete user', deleteError);
      return json({ error: 'delete_failed' }, 500);
    }

    return json({ ok: true });

  } catch (err) {
    console.error('prostar-delete-account error', err);
    return json({ error: 'internal_error' }, 500);
  }
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}