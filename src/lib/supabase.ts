import { createClient } from "@supabase/supabase-js";

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
      { error: "Supabase is not configured. Add the new project URL and publishable key." },
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
    let detail = "Cloud request failed. Check the new Supabase deployment.";
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

export async function sendMagicLink(email: string): Promise<string | null> {
  if (!supabase) return "Supabase is not configured.";
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href },
  });
  return error?.message ?? null;
}


export async function verifyEmailCode(email: string, token: string): Promise<{ error: string | null; email: string }> {
  if (!supabase) return { error: "Supabase is not configured.", email };
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: "email",
  });
  return { error: error?.message ?? null, email: data.user?.email ?? email };
}
