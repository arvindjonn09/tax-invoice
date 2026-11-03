import nodemailer from "nodemailer";

/** A rendered email. Addresses and links stay inside the encrypted outbox payload. */
export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

/** ADR 0004 D7: the outbox talks to providers only through this port. */
export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

/** Tests: keeps every message in memory. */
export class MemoryTransport implements EmailTransport {
  readonly name = "memory";
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
    return { providerMessageId: `memory-${this.sent.length}` };
  }
}

/** Development without SMTP: prints the subject and any link, never the address. */
export class ConsoleTransport implements EmailTransport {
  readonly name = "console";
  async send(message: EmailMessage) {
    const link = message.text.match(/https?:\/\/\S+/)?.[0];
    console.info(
      `[email] ${message.subject}${link ? ` → ${link}` : ""} (recipient hidden)`,
    );
    return { providerMessageId: `console-${crypto.randomUUID()}` };
  }
}

export type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  replyTo?: string;
};

/** Zoho Mail (ADR 0004 D7): implicit TLS with certificate checks always on. */
export class SmtpTransport implements EmailTransport {
  readonly name = "smtp";
  private readonly transporter;
  constructor(private readonly settings: SmtpSettings) {
    this.transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      requireTLS: !settings.secure,
      auth: { user: settings.user, pass: settings.password },
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  async send(message: EmailMessage) {
    const info = await this.transporter.sendMail({
      from: this.settings.from,
      ...(this.settings.replyTo ? { replyTo: this.settings.replyTo } : {}),
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
    return { providerMessageId: String(info.messageId ?? "").slice(0, 200) };
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * SMTP when configured; otherwise the console in development. Production
 * without SMTP fails closed rather than silently dropping mail.
 */
export function transportFromEnv(
  env: Env,
  production: boolean,
): EmailTransport {
  const { SMTP_HOST, SMTP_USER, SMTP_PASSWORD } = env;
  if (SMTP_HOST && SMTP_USER && SMTP_PASSWORD) {
    const port = Number(env.SMTP_PORT ?? "465");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("SMTP_PORT is invalid");
    }
    return new SmtpTransport({
      host: SMTP_HOST,
      port,
      secure: (env.SMTP_SECURE ?? "true") !== "false",
      user: SMTP_USER,
      password: SMTP_PASSWORD,
      from: env.EMAIL_FROM ?? SMTP_USER,
      ...(env.EMAIL_REPLY_TO ? { replyTo: env.EMAIL_REPLY_TO } : {}),
    });
  }
  if (production) throw new Error("SMTP is not configured");
  return new ConsoleTransport();
}
