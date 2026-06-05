import nodemailer, { type Transporter } from "nodemailer";

/** Optional attachment forwarded to transports that support it (e.g. Gmail SMTP). */
export type OutboundAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

export type OutboundEmail = {
  to: string;
  subject: string;
  body: string;
  meta?: Record<string, unknown>;
  attachments?: OutboundAttachment[];
};

export interface EmailAdapter {
  send(email: OutboundEmail): Promise<{ ok: true } | { ok: false; error: string }>;
}

export class ConsoleEmailAdapter implements EmailAdapter {
  async send(email: OutboundEmail) {
    const redacted = {
      ...email,
      attachments: email.attachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        contentBytes:
          typeof a.content === "string"
            ? Buffer.byteLength(a.content, "utf8")
            : a.content.byteLength,
      })),
    };
    console.log("[email:console]", JSON.stringify(redacted, null, 2));
    return { ok: true as const };
  }
}

export class MailchimpEmailAdapter implements EmailAdapter {
  async send() {
    return {
      ok: false as const,
      error: "MailchimpEmailAdapter not implemented — configure API keys and templates",
    };
  }
}

export type GmailAdapterOptions = {
  /** Full Gmail address used to authenticate, e.g. "club.director@gmail.com". */
  user: string;
  /** Gmail App Password (16 chars). NOT the regular account password. */
  appPassword: string;
  /** Friendly From name shown in clients (e.g. the league name). */
  fromName?: string;
};

/**
 * Sends mail through Gmail's SMTP server (smtp.gmail.com:465).
 *
 * The Google account must:
 *   1. Have 2-Step Verification enabled, and
 *   2. Generate an App Password (https://myaccount.google.com/apppasswords)
 * The 16-character App Password is then used here, not the user's normal password.
 */
export class GmailEmailAdapter implements EmailAdapter {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(opts: GmailAdapterOptions) {
    if (!opts.user || !opts.appPassword) {
      throw new Error(
        "GmailEmailAdapter requires GMAIL_USER and GMAIL_APP_PASSWORD",
      );
    }
    this.transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: opts.user, pass: opts.appPassword },
    });
    this.from = opts.fromName
      ? `"${opts.fromName.replace(/"/g, "")}" <${opts.user}>`
      : opts.user;
  }

  async send(email: OutboundEmail) {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: email.to,
        subject: email.subject,
        text: email.body,
        attachments: email.attachments?.length
          ? email.attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType:
                a.contentType ?? "application/octet-stream; charset=utf-8",
            }))
          : undefined,
      });
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export function createEmailAdapter(
  kind: "console" | "mailchimp" | "smtp" | "gmail",
  opts?: { gmail?: GmailAdapterOptions },
): EmailAdapter {
  if (kind === "gmail") {
    if (!opts?.gmail) {
      console.warn(
        "[email] EMAIL_ADAPTER=gmail but GMAIL_USER/GMAIL_APP_PASSWORD missing — falling back to console adapter",
      );
      return new ConsoleEmailAdapter();
    }
    return new GmailEmailAdapter(opts.gmail);
  }
  if (kind === "mailchimp") return new MailchimpEmailAdapter();
  return new ConsoleEmailAdapter();
}
