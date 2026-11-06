import type { Metadata } from "next";

import { Account } from "@/components/account/account";

export const metadata: Metadata = {
  title: "Account · QRB",
  description: "Your QRB API key and today's usage of your daily budget.",
  robots: { index: false },
};

export default function AccountPage() {
  return <Account />;
}
