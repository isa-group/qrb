import type { CaptchaVerifier } from "../../src/captcha";

/** Accepts every token; records what it was asked. */
export const acceptCaptcha: CaptchaVerifier = { verify: async () => true };

export interface StubCaptcha extends CaptchaVerifier {
  calls: { token: string; remoteIp?: string }[];
  /** Tokens that pass (default: any token except "bad"). */
  mode: "ok" | "outage";
}

/** Stub verifier: tokens equal to "bad" fail, `mode = "outage"` throws as if Turnstile were unreachable. */
export function stubCaptcha(): StubCaptcha {
  const stub: StubCaptcha = {
    calls: [],
    mode: "ok",
    async verify(args) {
      stub.calls.push(args);
      if (stub.mode === "outage") {
        const { CaptchaUnavailableError } = await import("../../src/captcha");
        throw new CaptchaUnavailableError("down");
      }
      return args.token !== "bad";
    },
  };
  return stub;
}
