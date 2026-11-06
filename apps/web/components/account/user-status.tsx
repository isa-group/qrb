"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useAccount, type AccountUser } from "@/lib/auth";

import styles from "./user-status.module.css";

/** The visitor's initial, or their provider avatar, in a 24px disc. */
export function Avatar({ user, size = 24 }: { user: AccountUser; size?: number }) {
  const initial = (user.name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className={styles.avatar} style={{ width: size, height: size }} aria-hidden>
      {user.image ? (
        // Provider avatars come from GitHub's CDN; next/image would need its domain configured.
        <img src={user.image} alt="" width={size} height={size} referrerPolicy="no-referrer" />
      ) : (
        initial
      )}
    </span>
  );
}

/**
 * The nav's account entry: "Sign in" when signed out, the avatar and first name when signed in
 * (both link to their page). Nothing while the session is unknown or when accounts are not
 * served (the site talking to the API without the gateway).
 */
export function UserStatus({ variant = "bar", onNavigate }: { variant?: "bar" | "menu"; onNavigate?: () => void }) {
  const account = useAccount();
  const pathname = usePathname();
  if (account.status === "loading" || account.status === "unavailable") return null;

  if (account.status === "signed-out") {
    return (
      <Link
        href="/signin"
        className={variant === "bar" ? `${styles.link} title-4` : "heading-3"}
        aria-current={pathname === "/signin" ? "page" : undefined}
        onClick={onNavigate}
      >
        Sign in
      </Link>
    );
  }

  const first = account.user.name.split(/\s+/)[0] || "Account";
  return (
    <Link
      href="/account"
      className={variant === "bar" ? `${styles.link} ${styles.user} title-4` : "heading-3"}
      aria-current={pathname === "/account" ? "page" : undefined}
      aria-label={`Account: ${account.user.name}`}
      onClick={onNavigate}
    >
      {variant === "bar" ? (
        <>
          <Avatar user={account.user} />
          <span className={styles.name}>{first}</span>
        </>
      ) : (
        "Account"
      )}
    </Link>
  );
}
