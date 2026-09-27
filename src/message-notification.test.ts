import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { db } from "./db.js";
import type { MailTransport, OutboundMail } from "./mail.js";
import { isEmailAddress, parseMailbox, readSmtpConfig } from "./mail.js";
import {
  acceptGuestMessage,
  buildGuestMessageMail,
  escapeHtml,
  notifyOwnersOfGuestMessage,
  parseNotificationEmails,
  relevantPageUrl,
  setGuestMessageMailTransportForTests,
  vaultLinkFromRequest,
  type MailLog
} from "./message-notification.js";
import { SpeakeasyError } from "./speakeasy.js";
import { app } from "./server.js";

function captureLog() {
  const entries: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
  const logger: MailLog = {
    info: (fields, message) => entries.push({ level: "info", fields, message }),
    warn: (fields, message) => entries.push({ level: "warn", fields, message }),
    error: (fields, message) => entries.push({ level: "error", fields, message })
  };
  return { entries, logger };
}

function recordingTransport(sent: OutboundMail[], fail?: Error): MailTransport {
  return {
    async send(mail) {
      sent.push(mail);
      if (fail) throw fail;
    }
  };
}

describe("guest message email notifications", { concurrency: false }, () => {
  after(() => {
    setGuestMessageMailTransportForTests(undefined);
  });

  test("parseNotificationEmails keeps unique valid addresses", () => {
    assert.deepEqual(
      parseNotificationEmails(" one@example.com, two@example.com, one@example.com, not-an-email, "),
      ["one@example.com", "two@example.com"]
    );
    assert.deepEqual(parseNotificationEmails(undefined), []);
    assert.equal(isEmailAddress("owner+tag@example.com"), true);
    assert.equal(parseMailbox("Vault <owner@example.com>"), "Vault <owner@example.com>");
    assert.equal(readSmtpConfig({} as NodeJS.ProcessEnv), null);
  });

  test("a stored message notifies every configured recipient", async () => {
    const sent: OutboundMail[] = [];
    const { logger } = captureLog();
    const env = {
      MESSAGE_NOTIFICATION_EMAILS: "one@example.com, two@example.com"
    } as NodeJS.ProcessEnv;
    const message = await acceptGuestMessage(
      {
        sender_name: "Dana",
        contact_info: "dana@example.com",
        body: "Where is the door?"
      },
      {
        env,
        transport: recordingTransport(sent),
        pageUrl: "http://vault.local/guest",
        vaultUrl: "http://vault.local/",
        logger
      }
    );
    try {
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0]?.to, ["one@example.com", "two@example.com"]);
      assert.equal(sent[0]?.replyTo, "dana@example.com");
      assert.match(sent[0]?.subject ?? "", /Dana/);
      assert.match(sent[0]?.text ?? "", /Where is the door\?/);
      assert.match(sent[0]?.text ?? "", /dana@example.com/);
      assert.match(sent[0]?.text ?? "", /Guest contact form/);
      assert.match(sent[0]?.text ?? "", /http:\/\/vault\.local\/guest/);
      assert.match(sent[0]?.text ?? "", /Open Smokey Vault: http:\/\/vault\.local\//);
      assert.match(sent[0]?.html ?? "", /Where is the door\?/);
      assert.equal(message.sender_name, "Dana");
      const row = db.prepare("SELECT id FROM messages WHERE id=?").get(message.id) as { id: number };
      assert.equal(row.id, message.id);
    } finally {
      db.prepare("DELETE FROM messages WHERE id=?").run(message.id);
    }
  });

  test("missing sender fields do not crash notification creation", () => {
    const mail = buildGuestMessageMail({
      sender_name: "",
      contact_info: null,
      body: undefined,
      created_at: "",
      pageUrl: "javascript:alert(1)",
      vaultUrl: "not a url"
    });
    assert.match(mail.subject, /a guest/);
    assert.equal(mail.subject.includes("\n"), false);
    assert.match(mail.text, /From: Not provided/);
    assert.match(mail.text, /Contact: Not provided/);
    assert.match(mail.text, /Received: Not available/);
    assert.match(mail.text, /\(No message text\)/);
    assert.equal(mail.text.includes("javascript:"), false);
    assert.equal(mail.html.includes("javascript:"), false);
    assert.equal(mail.replyTo, undefined);

    const named = buildGuestMessageMail({
      sender_name: "Dana\r\nBcc: leak@example.com",
      contact_info: "555-0100",
      body: "Hello",
      created_at: "2026-09-27 13:48:00"
    });
    assert.equal(named.subject.includes("\n"), false);
    assert.equal(named.subject.includes("\r"), false);
    assert.match(named.text, /2026-09-27 13:48:00 UTC/);
    assert.equal(named.replyTo, undefined);
  });

  test("message text is escaped before it is placed in HTML", () => {
    const hostile = `<script>alert("x")</script> & 'quotes'`;
    const mail = buildGuestMessageMail({
      sender_name: hostile,
      contact_info: "dana@example.com",
      body: hostile,
      created_at: "2026-09-27 13:48:00"
    });
    assert.equal(mail.html.includes("<script>"), false);
    assert.match(mail.html, /&lt;script&gt;/);
    assert.match(mail.html, /&amp;/);
    assert.match(mail.html, /&#39;quotes&#39;/);
    assert.equal(escapeHtml(`a < b & "c"`), "a &lt; b &amp; &quot;c&quot;");
    assert.match(mail.text, /<script>alert\("x"\)<\/script>/);
  });

  test("a provider failure still returns the stored message", async () => {
    const secret = "super-secret-smtp-pass";
    const { entries, logger } = captureLog();
    const env = {
      MESSAGE_NOTIFICATION_EMAILS: "one@example.com, two@example.com",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "vault@example.com",
      SMTP_PASS: secret
    } as NodeJS.ProcessEnv;
    const message = await acceptGuestMessage(
      { sender_name: "Dana", contact_info: "dana@example.com", body: "Still save me" },
      {
        env,
        transport: recordingTransport([], new Error(`535 auth failed for ${secret}`)),
        logger
      }
    );
    try {
      const row = db.prepare("SELECT body FROM messages WHERE id=?").get(message.id) as { body: string };
      assert.equal(row.body, "Still save me");
      assert.equal(entries.some((entry) => entry.level === "error"), true);
      const logged = JSON.stringify(entries);
      assert.equal(logged.includes(secret), false);
      assert.match(logged, /\[redacted\]/);
    } finally {
      db.prepare("DELETE FROM messages WHERE id=?").run(message.id);
    }
  });

  test("SMTP_PASS is redacted even when the rest of SMTP is unset", async () => {
    const secret = "route-smtp-secret-value";
    const { entries, logger } = captureLog();
    const outcome = await notifyOwnersOfGuestMessage(
      { sender_name: "Dana", contact_info: "dana@example.com", body: "Hello" },
      {
        env: {
          MESSAGE_NOTIFICATION_EMAILS: "one@example.com",
          SMTP_PASS: secret
        } as NodeJS.ProcessEnv,
        transport: recordingTransport([], new Error(`down ${secret}`)),
        logger
      }
    );
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.equal(outcome.error.includes(secret), false);
    assert.match(outcome.error, /\[redacted\]/);
    assert.equal(JSON.stringify(entries).includes(secret), false);
  });

  test("an invalid message is rejected before any notification attempt", async () => {
    const sent: OutboundMail[] = [];
    const before = db.prepare("SELECT COUNT(*) AS total FROM messages").get() as { total: number };
    await assert.rejects(
      () => acceptGuestMessage(
        { sender_name: "Dana", contact_info: "dana@example.com", body: "   " },
        {
          env: { MESSAGE_NOTIFICATION_EMAILS: "one@example.com" } as NodeJS.ProcessEnv,
          transport: recordingTransport(sent)
        }
      ),
      SpeakeasyError
    );
    const after = db.prepare("SELECT COUNT(*) AS total FROM messages").get() as { total: number };
    assert.equal(after.total, before.total);
    assert.equal(sent.length, 0);
  });

  test("no notification is attempted when recipients are not configured", async () => {
    const sent: OutboundMail[] = [];
    const outcome = await notifyOwnersOfGuestMessage(
      { sender_name: "Dana", contact_info: "dana@example.com", body: "Hello", created_at: "2026-09-27 13:48:00" },
      { env: {} as NodeJS.ProcessEnv, transport: recordingTransport(sent) }
    );
    assert.deepEqual(outcome, { status: "skipped", reason: "no_recipients" });
    assert.equal(sent.length, 0);
  });

  test("configured recipients without SMTP are skipped and warned", async () => {
    const { entries, logger } = captureLog();
    const outcome = await notifyOwnersOfGuestMessage(
      { id: 4, sender_name: "Dana", contact_info: "dana@example.com", body: "Hello" },
      {
        env: { MESSAGE_NOTIFICATION_EMAILS: "one@example.com" } as NodeJS.ProcessEnv,
        logger
      }
    );
    assert.deepEqual(outcome, { status: "skipped", reason: "smtp_unconfigured" });
    assert.equal(entries[0]?.level, "warn");
    assert.match(entries[0]?.message ?? "", /SMTP is not configured/);
  });

  test("page links stay on the vault host", () => {
    assert.equal(
      relevantPageUrl("https://evil.example/phish", ["vault.local:6616"]),
      null
    );
    assert.equal(
      relevantPageUrl("http://vault.local:6616/guest", ["vault.local:6616", "https://bar.example/"]),
      "http://vault.local:6616/guest"
    );
    assert.equal(
      vaultLinkFromRequest({ configured: "javascript:alert(1)", protocol: "http", host: "vault.local" }),
      "http://vault.local/"
    );
    assert.equal(
      vaultLinkFromRequest({ configured: "https://bar.example/vault", protocol: "http", host: "vault.local" }),
      "https://bar.example/vault"
    );
  });

  test("POST /api/messages emails owners and still accepts the message when SMTP fails", async () => {
    const previousEmails = process.env.MESSAGE_NOTIFICATION_EMAILS;
    const previousPass = process.env.SMTP_PASS;
    const secret = "route-smtp-secret-value";
    const sent: OutboundMail[] = [];
    process.env.MESSAGE_NOTIFICATION_EMAILS = "one@example.com, two@example.com";
    process.env.SMTP_PASS = secret;
    setGuestMessageMailTransportForTests(recordingTransport(sent));
    let messageId = 0;
    try {
      const ok = await app.inject({
        method: "POST",
        url: "/api/messages",
        headers: {
          referer: "http://vault.local:6616/",
          host: "vault.local:6616"
        },
        payload: {
          sender_name: "Dana",
          contact_info: "dana@example.com",
          body: "Bring ice<script>"
        }
      });
      assert.equal(ok.statusCode, 201);
      const body = ok.json() as { ok: boolean; id: number; created_at: string };
      messageId = body.id;
      assert.equal(body.ok, true);
      assert.equal(typeof body.created_at, "string");
      assert.equal(JSON.stringify(body).includes(secret), false);
      assert.equal(JSON.stringify(body).includes("smtp"), false);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0]?.to, ["one@example.com", "two@example.com"]);
      assert.match(sent[0]?.html ?? "", /Bring ice&lt;script&gt;/);
      assert.match(sent[0]?.text ?? "", /Bring ice<script>/);
      assert.match(sent[0]?.text ?? "", /http:\/\/vault\.local:6616\//);

      sent.length = 0;
      setGuestMessageMailTransportForTests({
        async send() {
          throw new Error(`down ${secret}`);
        }
      });
      const failed = await app.inject({
        method: "POST",
        url: "/api/messages",
        payload: { sender_name: "Dana", contact_info: "555-0100", body: "Saved anyway" }
      });
      assert.equal(failed.statusCode, 201);
      const failedBody = failed.json() as { id: number };
      const failedText = JSON.stringify(failed.json());
      assert.equal(failedText.includes(secret), false);
      assert.equal(failedText.includes("down"), false);
      const stored = db.prepare("SELECT body FROM messages WHERE id=?").get(failedBody.id) as { body: string };
      assert.equal(stored.body, "Saved anyway");
      db.prepare("DELETE FROM messages WHERE id=?").run(failedBody.id);

      setGuestMessageMailTransportForTests(recordingTransport(sent));
      const rejected = await app.inject({
        method: "POST",
        url: "/api/messages",
        payload: { sender_name: "", contact_info: "", body: "" }
      });
      assert.equal(rejected.statusCode, 400);
      assert.equal(sent.length, 0);
      const guestError = JSON.stringify(rejected.json());
      assert.equal(guestError.includes(secret), false);
    } finally {
      if (messageId) db.prepare("DELETE FROM messages WHERE id=?").run(messageId);
      setGuestMessageMailTransportForTests(undefined);
      if (previousEmails === undefined) delete process.env.MESSAGE_NOTIFICATION_EMAILS;
      else process.env.MESSAGE_NOTIFICATION_EMAILS = previousEmails;
      if (previousPass === undefined) delete process.env.SMTP_PASS;
      else process.env.SMTP_PASS = previousPass;
    }
  });
});
