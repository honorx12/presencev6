import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

const AuthContext = createContext(null);
const ROLE_KEY = 'sentry_role'; // cached alongside the Supabase session, so a refresh doesn't flash "signed out"

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [role, setRole] = useState(() => localStorage.getItem(ROLE_KEY) || null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setRole(null);
        localStorage.removeItem(ROLE_KEY);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  function setRoleAndCache(r) {
    setRole(r);
    if (r) localStorage.setItem(ROLE_KEY, r);
    else localStorage.removeItem(ROLE_KEY);
  }

  const value = {
    ready,
    token: session?.access_token || null,
    email: session?.user?.email || null,
    role,
    isTeacher: role === 'teacher' || role === 'developer',
    isDeveloper: role === 'developer',
    setRole: setRoleAndCache,
    signOut: async () => {
      await supabase.auth.signOut();
      setRoleAndCache(null);
    }
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
