import { createHash } from "node:crypto";

import type pino from "pino";

import { PushService, type PushPayload } from "./push-service.js";
import type { PushTokenStore } from "./token-store.js";

export type { PushPayload };

export interface PushNotificationSender {
  send(payload: PushPayload): Promise<void>;
}

/**
 * Optional plug-points for routing notifications to HTTP webhooks alongside
 * (or instead of) Expo. The env-var URL is process-wide; the session URL
 * accessor is invoked on every send so newly-registered or torn-down session
 * URLs are picked up without restarting.
 */
export interface WebhookSenderOptions {
  envWebhookUrl: string | null;
  getSessionWebhookUrls: () => string[];
  /** Plaintext daemon password used to derive the bearer (sha256(password)). */
  authPassword: string | null;
}

export function createPushNotificationSender(
  logger: pino.Logger,
  tokenStore: PushTokenStore,
  webhookOptions?: WebhookSenderOptions,
): PushNotificationSender {
  const pushService = new PushService(logger, tokenStore);
  const authBearer = webhookOptions?.authPassword
    ? createHash("sha256").update(webhookOptions.authPassword).digest("hex")
    : null;

  return {
    async send(payload) {
      const tokens = tokenStore.getAllTokens();
      const webhookUrls = collectWebhookUrls(webhookOptions);
      logger.info(
        { tokenCount: tokens.length, webhookCount: webhookUrls.length },
        "Sending push notification",
      );

      const tasks: Promise<void>[] = [];
      if (tokens.length > 0) {
        tasks.push(pushService.sendPush(tokens, payload));
      }
      if (webhookUrls.length > 0) {
        tasks.push(pushService.sendWebhooks(webhookUrls, payload, authBearer));
      }
      await Promise.all(tasks);
    },
  };
}

function collectWebhookUrls(options: WebhookSenderOptions | undefined): string[] {
  if (!options) return [];
  const set = new Set<string>();
  if (options.envWebhookUrl) set.add(options.envWebhookUrl);
  for (const url of options.getSessionWebhookUrls()) set.add(url);
  return [...set];
}
