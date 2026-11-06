import type { Metadata } from "next";

import { SignIn } from "@/components/account/sign-in";

export const metadata: Metadata = {
  title: "Sign in · QRB",
  description: "Sign in to QRB with GitHub or ORCID to create an API key with a daily budget of its own.",
  robots: { index: false },
};

export default function SignInPage() {
  return <SignIn />;
}
