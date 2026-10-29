"use client";

import { authClient } from "@/lib/auth/client";

// Anonymous (cookie-less-account) sessions count as signed out for display.
export function useAuthUser() {
  const { data, isPending } = authClient.useSession();
  const user = data?.user && !data.user.isAnonymous ? data.user : null;
  return { user, isPending };
}
