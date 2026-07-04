import React, { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { authApi, UserProfile } from '../lib/api';

const GITHUB_SCOPES = 'repo';

async function signInWithGitHub() {
  await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      scopes: GITHUB_SCOPES,
      redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
    },
  });
}

/**
 * Gates the app behind Supabase GitHub auth. When signed out it shows a login
 * screen; when signed in it renders a slim header (user + GitHub connection state
 * + sign out) above the app. On a fresh OAuth sign-in it captures the GitHub
 * `provider_token` (only present at that moment) and hands it to the backend to
 * store encrypted, so the user's PRs are attributed to them.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const storedTokenRef = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      // provider_token is only present right after the OAuth redirect. Capture it
      // once and store it server-side so we can commit on the user's behalf.
      if (next?.provider_token && !storedTokenRef.current) {
        storedTokenRef.current = true;
        const username = (next.user?.user_metadata as { user_name?: string })?.user_name;
        authApi
          .storeGithubToken(next.provider_token, username)
          .then(() => refreshProfile())
          .catch(() => {
            storedTokenRef.current = false;
          });
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (session) refreshProfile();
    else setProfile(null);
  }, [session]);

  function refreshProfile() {
    authApi
      .me()
      .then((r) => setProfile(r.user))
      .catch(() => setProfile(null));
  }

  if (!isSupabaseConfigured) {
    return (
      <Centered>
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold text-white mb-2">Authentication not configured</h1>
          <p className="text-slate-400 text-sm">
            Set <code className="text-blue-300">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
            <code className="text-blue-300">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to enable sign-in.
          </p>
        </div>
      </Centered>
    );
  }

  if (loading) {
    return (
      <Centered>
        <div className="text-slate-400 text-sm">Loading…</div>
      </Centered>
    );
  }

  if (!session) {
    return (
      <Centered>
        <div className="w-full max-w-sm text-center">
          <h1 className="text-2xl font-semibold text-white mb-1">ForgeAI</h1>
          <p className="text-slate-400 text-sm mb-6">
            Autonomous AI coding agents. Sign in to submit tasks and open pull requests
            under your own GitHub account.
          </p>
          <button
            onClick={signInWithGitHub}
            className="inline-flex items-center justify-center gap-2 w-full rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition-colors"
          >
            <GitHubIcon />
            Sign in with GitHub
          </button>
        </div>
      </Centered>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_rgba(59,130,246,0.12),_transparent_60%),linear-gradient(160deg,_#020617,_#0a1120_50%,_#0d1117)]">
      <header className="flex items-center justify-between gap-4 border-b border-white/10 px-4 sm:px-6 py-2.5">
        <span className="text-sm font-semibold text-white">ForgeAI</span>
        <div className="flex items-center gap-3 text-xs">
          {profile && !profile.hasGithubToken && (
            <button
              onClick={signInWithGitHub}
              className="rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 px-2.5 py-1 font-medium transition-colors"
              title="Reconnect GitHub to grant repo access"
            >
              Connect GitHub
            </button>
          )}
          {profile?.hasGithubToken && (
            <span className="inline-flex items-center gap-1.5 text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              GitHub{profile.githubUsername ? ` · ${profile.githubUsername}` : ''}
            </span>
          )}
          <span className="text-slate-400 hidden sm:inline">{profile?.email ?? session.user.email}</span>
          <button
            onClick={() => supabase.auth.signOut()}
            className="rounded-md border border-white/15 text-slate-300 hover:bg-white/5 px-2.5 py-1 transition-colors"
          >
            Sign out
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[radial-gradient(ellipse_at_top,_rgba(59,130,246,0.12),_transparent_60%),linear-gradient(160deg,_#020617,_#0a1120_50%,_#0d1117)]">
      {children}
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
