import nodemailer from "nodemailer";

/**
 * SMTP is the only mail transport. Guest-message copy and recipient rules live
 * in message-notification.ts so this file can be swapped without touching the route.
 */

export type OutboundMail = {
  to: string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
};

export type MailTransport = {
  send(mail: OutboundMail): Promise<void>;
};

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
};

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value) && !/[\r\n]/.test(value);
}

/** Accepts `name@host` or `Display Name <name@host>`. Strips header breaks. */
export function parseMailbox(value: string): string | null {
  const trimmed = value.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return null;
  const angled = trimmed.match(/^(.*)<([^<>]+)>\s*$/);
  const email = (angled?.[2] ?? trimmed).trim();
  if (!isEmailAddress(email)) return null;
  if (!angled) return email;
  const display = angled[1].replace(/[<>]/g, "").trim();
  return display ? `${display} <${email}>` : email;
}

function envFlag(value: string | undefined): boolean | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return null;
}

/** Null when host, port, or From cannot produce a message. Auth is optional (local relay). */
export function readSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim() ?? "";
  if (!host || /[\r\n\s]/.test(host)) return null;
  const portRaw = env.SMTP_PORT?.trim() || "587";
  if (!/^\d+$/.test(portRaw)) return null;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const from = parseMailbox(env.SMTP_FROM?.trim() || env.SMTP_USER?.trim() || "");
  if (!from) return null;
  const secureFlag = envFlag(env.SMTP_SECURE);
  return {
    host,
    port,
    secure: secureFlag ?? port === 465,
    user: (env.SMTP_USER ?? "").replace(/[\r\n]/g, "").trim(),
    pass: (env.SMTP_PASS ?? "").replace(/[\r\n]/g, ""),
    from
  };
}

export function createSmtpTransport(config: SmtpConfig): MailTransport {
  return {
    async send(mail) {
      const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.pass } : undefined
      });
      try {
        await transporter.sendMail({
          from: config.from,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          replyTo: mail.replyTo
        });
      } finally {
        transporter.close();
      }
    }
  };
}
