import { discordWebhookUrl, markDiscordNotified, pendingDiscordAlerts } from "./speakeasy.js";
import type { GuestMessage } from "./speakeasy-shared.js";

export const DISCORD_ALERT_INTERVAL_MS = 60_000;
const EMBED_COLOR = 0xff6b00;

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status">>;

export function messageEmbed(message: GuestMessage) {
  return {
    title: "Unanswered message at the vault door",
    description: message.body.slice(0, 1800),
    color: EMBED_COLOR,
    timestamp: new Date(`${message.created_at.replace(" ", "T")}Z`).toISOString(),
    fields: [
      { name: "From", value: message.sender_name || "Unknown", inline: true },
      { name: "Reach them at", value: message.contact_info || "Not provided", inline: true }
    ],
    footer: { text: "The Smoky Barrel Bar" }
  };
}

export async function postDiscordAlert(message: GuestMessage, fetcher: FetchLike = fetch): Promise<boolean> {
  const url = discordWebhookUrl();
  if (!url) return false;
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `A guest message has been waiting more than five minutes.`,
      embeds: [messageEmbed(message)]
    })
  });
  return response.ok;
}

/**
 * Announces unread messages that have gone unanswered past the alert delay.
 * Returns the number of messages announced so callers can log a summary.
 */
export async function flushDiscordAlerts(options: { fetcher?: FetchLike; now?: number } = {}): Promise<number> {
  if (!discordWebhookUrl()) return 0;
  const pending = pendingDiscordAlerts(options.now);
  let sent = 0;
  for (const message of pending) {
    if (!await postDiscordAlert(message, options.fetcher)) break;
    markDiscordNotified(message.id);
    sent += 1;
  }
  return sent;
}
