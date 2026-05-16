import type { PushTokenStore } from "./token-store.js";
import type pino from "pino";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;

/**
 * Service for sending Expo push notifications.
 * Handles batching and invalid token removal.
 */
export class PushService {
  private readonly logger: pino.Logger;
  private readonly tokenStore: PushTokenStore;

  constructor(logger: pino.Logger, tokenStore: PushTokenStore) {
    this.logger = logger.child({ component: "push-service" });
    this.tokenStore = tokenStore;
  }

  async sendPush(tokens: string[], payload: PushPayload): Promise<void> {
    if (tokens.length === 0) {
      return;
    }

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: "default",
    }));

    // Batch tokens (max 100 per request per Expo limits)
    const batches: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
      batches.push(messages.slice(i, i + MAX_BATCH_SIZE));
    }

    await Promise.all(batches.map((batch) => this.sendBatch(batch)));
  }

  /**
   * Fire-and-forget POST of the same payload to every configured webhook URL.
   * Webhook URLs are an opt-in alternative to Expo for clients that bring
   * their own notification bridge (e.g. the native iOS app + APNs relay).
   * Failures are logged and do not propagate.
   */
  async sendWebhooks(
    urls: string[],
    payload: PushPayload,
    authBearer: string | null,
  ): Promise<void> {
    if (urls.length === 0) {
      return;
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authBearer) {
      headers.Authorization = `Bearer ${authBearer}`;
    }
    const body = JSON.stringify(payload);
    await Promise.all(
      urls.map(async (url) => {
        try {
          const response = await fetch(url, { method: "POST", headers, body });
          if (!response.ok) {
            this.logger.warn(
              { url, status: response.status, statusText: response.statusText },
              "Webhook responded with non-2xx",
            );
          }
        } catch (error) {
          this.logger.warn({ err: error, url }, "Webhook POST failed");
        }
      }),
    );
  }

  private async sendBatch(messages: ExpoPushMessage[]): Promise<void> {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText },
          "Expo push API error",
        );
        return;
      }

      const result = (await response.json()) as { data: ExpoPushTicket[] };
      this.handleTickets(messages, result.data);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to send push notifications");
    }
  }

  private handleTickets(messages: ExpoPushMessage[], tickets: ExpoPushTicket[]): void {
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const message = messages[i];

      if (ticket.status === "error") {
        this.logger.error(
          { token: message.to, message: ticket.message, details: ticket.details },
          "Push failed for token",
        );

        // Remove invalid tokens
        if (
          ticket.details?.error === "DeviceNotRegistered" ||
          ticket.details?.error === "InvalidCredentials"
        ) {
          this.tokenStore.removeToken(message.to);
        }
      }
    }
  }
}
