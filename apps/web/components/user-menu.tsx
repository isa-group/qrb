"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { DropdownMenu } from "radix-ui";

import { useAuthUser } from "@/components/auth-session";
import { authClient } from "@/lib/auth/client";

export function UserMenu() {
  const { user, isPending } = useAuthUser();
  const router = useRouter();
  const pathname = usePathname();

  if (isPending) return <div className="h-8 w-16" aria-hidden />;

  if (!user) {
    const href = pathname && pathname !== "/signin" ? `/signin?next=${encodeURIComponent(pathname)}` : "/signin";
    return (
      <Link
        href={href}
        className="rounded-sm border border-hairline px-3 py-1.5 text-body font-medium text-ink-primary transition-colors hover:border-hairline-bright"
      >
        Sign in
      </Link>
    );
  }

  const name = user.name || "Account";
  const item =
    "flex w-full cursor-default items-center rounded-sm px-2 py-1.5 text-body text-ink-primary outline-none data-[highlighted]:bg-primary-dim";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="flex items-center gap-2 rounded-sm border border-hairline px-2 py-1 text-body text-ink-primary transition-colors hover:border-hairline-bright"
        aria-label={`Account menu for ${name}`}
      >
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.image} alt="" className="size-5 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <span className="flex size-5 items-center justify-center rounded-full bg-primary-dim text-caption text-primary">
            {name.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="hidden max-w-32 truncate sm:inline">{name}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-40 rounded-lg border border-hairline bg-panel p-1 shadow-md"
        >
          <DropdownMenu.Item asChild>
            <Link href="/account" className={item}>Account</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={item}
            onSelect={async () => {
              await authClient.signOut();
              router.replace("/");
            }}
          >
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
