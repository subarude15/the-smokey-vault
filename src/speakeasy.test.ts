import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AI_MIXOLOGIST_TIMEOUT_MS, DEFAULT_ENABLED_TABS, DEFAULT_TAB_ORDER, TAB_KEYS, appleCashLink,
  parseEnabledTabs, parseTabOrder, patronRank, serializeEnabledTabs, tipHandles, vaultDayDate
} from "./speakeasy-shared.js";
import { db, setSetting } from "./db.js";
import { flushDiscordAlerts, messageEmbed } from "./discord.js";
import {
  castDailyVote, createMessage, createPatron, dailyVoteTallies, deleteDailyVotesForItem,
  deletePatron, listLeaderboard, markMessageRead, pendingDiscordAlerts, SpeakeasyError, unreadMessageCount
} from "./speakeasy.js";

test("the mixologist client timeout leaves room for a slow LLM and one failover", () => {
  assert.equal(AI_MIXOLOGIST_TIMEOUT_MS, 15_000);
});

test("the vault day rolls at 4:00 AM so late-night votes stay on one date", () => {
  assert.equal(vaultDayDate(new Date(2026, 7, 22, 23, 30)), "2026-08-22");
  assert.equal(vaultDayDate(new Date(2026, 7, 23, 1, 15)), "2026-08-22");
  assert.equal(vaultDayDate(new Date(2026, 7, 23, 3, 59)), "2026-08-22");
  assert.equal(vaultDayDate(new Date(2026, 7, 23, 4, 0)), "2026-08-23");
  assert.equal(vaultDayDate(new Date(2026, 0, 1, 2, 0)), "2025-12-31");
});

test("enabled tabs fall back to the house defaults for bad input", () => {
  assert.deepEqual(parseEnabledTabs(undefined), DEFAULT_ENABLED_TABS);
  assert.deepEqual(parseEnabledTabs("not json"), DEFAULT_ENABLED_TABS);
  assert.deepEqual(parseEnabledTabs("[]"), DEFAULT_ENABLED_TABS);
  assert.equal(parseEnabledTabs('{"merch":1}').merch, 1);
  assert.equal(parseEnabledTabs('{"tipjar":0}').tipjar, 0);
  assert.equal(parseEnabledTabs('{"cocktails":"nope"}').cocktails, 0);
});

test("enabled tabs round-trip through serialization and ignore unknown keys", () => {
  const tabs = parseEnabledTabs('{"merch":1,"brewery":0,"mystery":1}');
  const json = serializeEnabledTabs(tabs);
  assert.deepEqual(parseEnabledTabs(json), tabs);
  assert.equal(JSON.parse(json).mystery, undefined);
});

test("tab order falls back to the default sequence for bad input", () => {
  assert.deepEqual(parseTabOrder(undefined), DEFAULT_TAB_ORDER);
  assert.deepEqual(parseTabOrder(""), DEFAULT_TAB_ORDER);
  assert.deepEqual(parseTabOrder("not json"), DEFAULT_TAB_ORDER);
  assert.deepEqual(parseTabOrder('{"overview":1}'), DEFAULT_TAB_ORDER);
});

test("tab order keeps the saved sequence, drops junk, and appends new tabs", () => {
  const order = parseTabOrder('["merch","tipjar","merch","mystery",7]');
  assert.deepEqual(order.slice(0, 2), ["merch", "tipjar"]);
  assert.equal(order.length, TAB_KEYS.length);
  assert.deepEqual([...order].sort(), [...TAB_KEYS].sort());
});

test("patron ranking breaks visit ties with the oldest update first", () => {
  const ranked = patronRank([
    { id: 1, name: "Dana", nickname: "", visit_count: 4, notes: "", created_at: "", updated_at: "2026-08-20" },
    { id: 2, name: "Ravi", nickname: "", visit_count: 9, notes: "", created_at: "", updated_at: "2026-08-21" },
    { id: 3, name: "Kim", nickname: "", visit_count: 4, notes: "", created_at: "", updated_at: "2026-08-01" }
  ]);
  assert.deepEqual(ranked.map((patron) => patron.name), ["Ravi", "Kim", "Dana"]);
});

test("tip handles build deep links and tolerate decorated input", () => {
  const handles = tipHandles({ tip_venmo: "@Nick-Vault", tip_cashapp: "$smokybarrel", tip_paypal: "" });
  assert.deepEqual(handles.map((handle) => handle.id), ["venmo", "cashapp"]);
  assert.equal(handles[0].href, "https://venmo.com/Nick-Vault");
  assert.equal(handles[0].hint, "@Nick-Vault");
  assert.equal(handles[1].href, "https://cash.app/$smokybarrel");
  assert.deepEqual(tipHandles({}), []);
});

test("Apple Cash links strip formatting and skip when no number is set", () => {
  assert.equal(appleCashLink("(610) 555-0134"), "sms:6105550134");
  assert.equal(appleCashLink(""), "");
  assert.match(appleCashLink("+16105550134", "$10 for the keg fund"), /^sms:\+16105550134\?&body=/);
});

function insertBeer(name: string) {
  return Number(db.prepare(
    "INSERT INTO packaged_beer(brewery, name, style, abv) VALUES(?, ?, ?, ?)"
  ).run("Tröegs", name, "Imperial Amber", 7.5).lastInsertRowid);
}

test("a patron gets one vote per bottle per vault day", () => {
  const itemId = insertBeer(`Daily vote ${Date.now()}`);
  const first = castDailyVote("packaged_beer", itemId, "Dana", 1);
  assert.equal(first.ok, true);
  assert.equal(first.already_voted, false);
  assert.equal(first.up, 1);

  const repeat = castDailyVote("packaged_beer", itemId, "  dana  ", -1);
  assert.equal(repeat.ok, false);
  assert.equal(repeat.already_voted, true);
  assert.match(repeat.notice, /already rated this one tonight/);
  assert.equal(repeat.up, 1, "a blocked vote must not change the tally");
  assert.equal(repeat.down, 0);

  const other = castDailyVote("packaged_beer", itemId, "Ravi", -1);
  assert.equal(other.ok, true);
  assert.equal(other.net, 0);

  // Tomorrow's vault day frees the same patron up again.
  const tomorrow = new Date(Date.now() + 86_400_000);
  assert.equal(castDailyVote("packaged_beer", itemId, "Dana", 1, tomorrow).ok, true);

  assert.deepEqual(dailyVoteTallies("packaged_beer")[itemId], { up: 1, down: 1, net: 0 });
  deleteDailyVotesForItem("packaged_beer", itemId);
  assert.equal(dailyVoteTallies("packaged_beer")[itemId], undefined);
  db.prepare("DELETE FROM packaged_beer WHERE id=?").run(itemId);
});

test("daily votes reject blank names, bad values, and missing bottles", () => {
  const itemId = insertBeer(`Guarded ${Date.now()}`);
  assert.throws(() => castDailyVote("packaged_beer", itemId, "   ", 1), SpeakeasyError);
  assert.throws(() => castDailyVote("packaged_beer", itemId, "Dana", 0), SpeakeasyError);
  assert.throws(() => castDailyVote("packaged_beer", 9_999_999, "Dana", 1), /not found/i);
  db.prepare("DELETE FROM packaged_beer WHERE id=?").run(itemId);
});

test("patron names are unique and the leaderboard caps at fifteen", () => {
  const name = `Regular ${Date.now()}`;
  const patron = createPatron({ name, visit_count: 3 });
  assert.equal(patron.visit_count, 3);
  assert.throws(() => createPatron({ name: name.toLowerCase() }), /already on the leaderboard/);
  assert.throws(() => createPatron({ name: "  " }), SpeakeasyError);
  assert.ok(listLeaderboard().length <= 15);
  assert.equal(deletePatron(patron.id), true);
  assert.equal(deletePatron(patron.id), false);
});

test("Discord announces only unread messages older than five minutes, once each", async () => {
  db.prepare("DELETE FROM messages").run();
  setSetting("discord_webhook_url", "https://discord.com/api/webhooks/test");

  const fresh = createMessage({ sender_name: "Fresh", contact_info: "a@b.c", body: "Just asked" });
  const stale = createMessage({ sender_name: "Stale", contact_info: "d@e.f", body: "Waiting a while" });
  const answered = createMessage({ sender_name: "Answered", contact_info: "g@h.i", body: "Already handled" });
  const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString().replace("T", " ").slice(0, 19);
  db.prepare("UPDATE messages SET created_at=? WHERE id IN (?, ?)").run(sixMinutesAgo, stale.id, answered.id);
  markMessageRead(answered.id, true);

  assert.deepEqual(pendingDiscordAlerts().map((message) => message.id), [stale.id]);
  assert.equal(unreadMessageCount(), 2);

  const posted: string[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    posted.push(String(init?.body ?? ""));
    return { ok: true, status: 204 };
  };

  assert.equal(await flushDiscordAlerts({ fetcher }), 1);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /Waiting a while/);
  // Already announced, so a second pass sends nothing.
  assert.equal(await flushDiscordAlerts({ fetcher }), 0);
  assert.equal(posted.length, 1);

  setSetting("discord_webhook_url", "");
  assert.equal(await flushDiscordAlerts({ fetcher }), 0, "no webhook means no announcements");
  db.prepare("DELETE FROM messages WHERE id IN (?, ?, ?)").run(fresh.id, stale.id, answered.id);
});

test("the Discord embed carries the sender, contact, and body", () => {
  const embed = messageEmbed({
    id: 7,
    sender_name: "Dana",
    contact_info: "dana@example.com",
    body: "What is the address for Saturday?",
    is_read: 0,
    discord_notified: 0,
    created_at: "2026-08-22 23:15:00"
  });
  assert.equal(embed.description, "What is the address for Saturday?");
  assert.deepEqual(embed.fields.map((field) => field.value), ["Dana", "dana@example.com"]);
  assert.equal(embed.timestamp, "2026-08-22T23:15:00.000Z");
});
