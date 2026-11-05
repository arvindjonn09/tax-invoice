import type { EmailMessage } from "../email";

/**
 * Account emails (ADR 0004 D7). Addresses that aren't verified yet may belong
 * to someone else, so these contain no user-entered text (S2 AC9): only fixed
 * wording, the app URL and a single-use link.
 */
export function verificationEmail(
  to: string,
  appUrl: string,
  token: string,
): EmailMessage {
  const link = `${appUrl}/verify-email#token=${token}`;
  return {
    to,
    subject: "Verify your email for JobFlow",
    text: [
      "Welcome to JobFlow.",
      "",
      "Confirm this is your email address by opening the link below. It works once and expires in 24 hours.",
      "",
      link,
      "",
      "If you didn't create a JobFlow account, you can ignore this email.",
    ].join("\n"),
  };
}

export function accountExistsEmail(to: string, appUrl: string): EmailMessage {
  return {
    to,
    subject: "You already have a JobFlow account",
    text: [
      "Someone tried to create a JobFlow account with this email address, but one already exists.",
      "",
      `If it was you, sign in here: ${appUrl}/login`,
      "",
      "If it wasn't you, no action is needed. Your account hasn't changed.",
    ].join("\n"),
  };
}

/** No company name or inviter: the invitation's creator chose those (S2 AC9). */
export function invitedExistingEmail(to: string, appUrl: string): EmailMessage {
  return {
    to,
    subject: "Your JobFlow invitation",
    text: [
      "Someone used a JobFlow invitation for this email address, which already has an account.",
      "",
      `If it was you, sign in here, then reopen the invitation link: ${appUrl}/login`,
      "",
      "If it wasn't you, no action is needed. Your account hasn't changed.",
    ].join("\n"),
  };
}
