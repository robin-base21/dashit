/**
 * Outbound email. One interface so a real provider (Resend/SES/SMTP) drops in later without
 * touching the routes.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Writes to stdout. The default everywhere until a provider is configured. */
export class ConsoleEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    console.log(`[email] to=${message.to} :: ${message.subject}\n${message.body}`);
  }
}

/**
 * Sent when someone tries to sign up with an address that already has an account. The HTTP
 * response stays identical either way, so this email is the only thing that tells the difference —
 * and it only reaches the person who actually owns the address.
 */
export function existingAccountEmail(to: string): EmailMessage {
  return {
    to,
    subject: "You already have a DashIt account",
    body:
      "Someone asked to create a DashIt account with this address, but it already has one.\n\n" +
      "If that was you, sign in with your passkey instead — no code needed. If your passkey is on " +
      "another device, choose \u201cuse a passkey from another device\u201d in your browser\u2019s prompt.\n\n" +
      "If it was not you, nothing has happened and you can ignore this.",
  };
}

export function codeEmail(to: string, code: string, purpose: "register" | "enroll"): EmailMessage {
  const subject = purpose === "register" ? "Your DashIt sign-up code" : "Confirm a new passkey";
  const lead =
    purpose === "register"
      ? "Use this code to finish creating your DashIt account."
      : "A new passkey is being added to your DashIt account. Use this code to confirm it.";
  return { to, subject, body: `${lead}\n\n    ${code}\n\nIt expires in 15 minutes.` };
}
