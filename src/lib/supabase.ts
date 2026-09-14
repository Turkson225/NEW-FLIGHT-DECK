import { createClient, type User } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const supabase = url && key
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export const supabaseConfigured = Boolean(supabase);

export type AuthResult = {
  error: string | null;
  email: string;
  name: string;
  signedIn: boolean;
  needsConfirmation: boolean;
};

function safeName(user: User | null, email: string): string {
  const metadataName = user?.user_metadata?.full_name ?? user?.user_metadata?.display_name;
  if (typeof metadataName === "string" && metadataName.trim()) return metadataName.trim();
  const emailName = email.split("@")[0].replace(/[._-]+/g, " ").trim();
  return emailName ? emailName.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Flight Deck Operator";
}

function authResult(user: User | null, fallbackEmail: string, signedIn: boolean, needsConfirmation = false): AuthResult {
  const email = user?.email ?? fallbackEmail;
  return {
    error: null,
    email,
    name: safeName(user, email),
    signedIn,
    needsConfirmation,
  };
}

function redirectUrl(): string {
  return window.location.origin + window.location.pathname;
}

export function workspaceId(): string | undefined {
  return new URLSearchParams(window.location.search).get("workspace")
    || import.meta.env.VITE_WORKSPACE_ID
    || undefined;
}

export async function cloudRequest(path: string, options?: RequestInit): Promise<Response> {
  const parsed = new URL(path, window.location.origin);
  const resource = parsed.pathname.split("/").filter(Boolean).slice(-1)[0];
  const method = options?.method ?? "GET";

  if (!supabase) {
    return Response.json(
      { error: "Supabase is not configured. Add the project URL and publishable key." },
      { status: 503 },
    );
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return Response.json({ error: "Sign in to access protected aircraft data." }, { status: 401 });
  }

  const body = typeof options?.body === "string" ? JSON.parse(options.body) : null;
  const { data, error } = await supabase.functions.invoke("flight-api", {
    body: {
      resource,
      method,
      query: Object.fromEntries(parsed.searchParams),
      workspace: workspaceId(),
      body,
    },
    signal: options?.signal ?? undefined,
  });

  if (error) {
    let detail = "Cloud request failed. Check the Supabase deployment.";
    if (error.context instanceof Response) {
      try {
        detail = (await error.context.json()).error ?? detail;
      } catch {
        // Keep the safe generic message.
      }
    }
    return Response.json({ error: detail }, { status: 503 });
  }

  return Response.json(data?.data ?? {}, { status: data?.status ?? 200 });
}

export async function createAccount(name: string, email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { error: "Supabase is not configured.", email, name, signedIn: false, needsConfirmation: false };
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: name.trim(), display_name: name.trim() },
      emailRedirectTo: redirectUrl(),
    },
  });
  if (error) return { error: error.message, email, name, signedIn: false, needsConfirmation: false };
  if (data.user?.identities?.length === 0) {
    return { error: "An account already exists for this email. Sign in instead.", email, name, signedIn: false, needsConfirmation: false };
  }
  return authResult(data.user, email, Boolean(data.session), Boolean(data.user && !data.session));
}

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { error: "Supabase is not configured.", email, name: "", signedIn: false, needsConfirmation: false };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message, email, name: "", signedIn: false, needsConfirmation: false };
  return authResult(data.user, email, Boolean(data.session));
}

export async function sendMagicLink(email: string): Promise<string | null> {
  if (!supabase) return "Supabase is not configured.";
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectUrl(),
      shouldCreateUser: false,
    },
  });
  return error?.message ?? null;
}

export async function verifyEmailCode(email: string, token: string): Promise<AuthResult> {
  if (!supabase) return { error: "Supabase is not configured.", email, name: "", signedIn: false, needsConfirmation: false };
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: "email",
  });
  if (error) return { error: error.message, email, name: "", signedIn: false, needsConfirmation: false };
  return authResult(data.user, email, Boolean(data.session));
}

export async function requestPasswordReset(email: string): Promise<string | null> {
  if (!supabase) return "Supabase is not configured.";
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: redirectUrl(),
  });
  return error?.message ?? null;
}

export async function updatePassword(password: string): Promise<string | null> {
  if (!supabase) return "Supabase is not configured.";
  const { error } = await supabase.auth.updateUser({ password });
  return error?.message ?? null;
}
