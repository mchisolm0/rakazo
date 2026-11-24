import { randomUUID } from "node:crypto";
import type { NotificationProvider, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createOrganizationForUser,
  createThreadEvents,
  readMessageBlocks,
  runAsSystem,
} from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mountWebhookHttpRoutes, WEBHOOK_SECRET_KIND } from "./webhook.js";

const describePostgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

const TOKEN = "webhook-post-token";

describePostgres("webhook post (PostgreSQL)", () => {
  let runtime: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const userId = `user-${randomUUID()}`;
  let spaceId: string;

  beforeAll(async () => {
    runtime = createDb(process.env.DATABASE_URL!);
    system = asSystem(runtime.prisma);
    await system.user.create({
      data: { id: userId, name: "Owner", email: `${userId}@rakazo.test`, emailVerified: true },
    });
    spaceId = (await createOrganizationForUser(system, { userId, name: "Posts" })).defaultSpaceId;
  });

  afterAll(async () => {
    await system.organization.deleteMany({ where: { members: { some: { userId } } } });
    await system.user.deleteMany({ where: { id: userId } });
    await runtime?.prisma.$disconnect();
    await runtime?.pool.end();
  });

  /** A bot with a webhook in `space`, and an app that posts to it. */
  async function webhookBot(space: string) {
    const secret = await system.secret.create({
      data: { userId, spaceId: space, kind: WEBHOOK_SECRET_KIND, ciphertext: "sealed" },
    });
    const bot = await system.bot.create({
      data: {
        spaceId: space,
        userId,
        name: "Fleet",
        color: "ink",
        webhookSecretId: secret.id,
        thread: { create: { spaceId: space, userId } },
      },
      select: { id: true, thread: { select: { id: true } } },
    });
    const send = vi.fn(async () => undefined);
    const app = new Hono();
    app.use("/api/v1/bots/*", (_c, next) => runAsSystem("bot webhook", next));
    mountWebhookHttpRoutes(app, {
      prisma: runtime.prisma,
      secrets: { load: async () => TOKEN } as unknown as SecretStore,
      events: createThreadEvents(runtime.prisma),
      jobs: { enqueue: vi.fn() },
      notifications: { send } as unknown as NotificationProvider,
      linkSchemes: ["https", "app"],
    });
    const post = (body: unknown) =>
      app.request(`/api/v1/bots/${bot.id}/webhook`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { bot, send, post };
  }

  it("posts the text and buttons as the bot without a routine or run, and pushes it", async () => {
    const { bot, send, post } = await webhookBot(spaceId);
    const buttons = [{ label: "Open", url: "app://threads/env-1/thread-1" }];

    const response = await post({ post: { text: "Build **finished**", buttons } });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; messageId: string };
    expect(body.ok).toBe(true);
    const message = await system.message.findUniqueOrThrow({
      where: { id: body.messageId },
      select: { id: true, threadId: true, role: true, botId: true, runId: true, blocks: true },
    });
    expect(message).toMatchObject({ threadId: bot.thread!.id, role: "bot", botId: bot.id });
    expect(message.runId).toBeNull();
    expect(readMessageBlocks(message).blocks).toEqual([
      { kind: "post", markdown: "Build **finished**" },
      { kind: "buttons", buttons },
    ]);
    expect(await system.run.count({ where: { botId: bot.id } })).toBe(0);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "completion",
          title: "Fleet",
          body: "Build finished",
          threadId: bot.thread!.id,
        }),
        expect.objectContaining({ userId }),
      ),
    );
  });

  it("refuses a post into a Space being deleted with a 409 and writes nothing", async () => {
    const { defaultSpaceId } = await createOrganizationForUser(system, {
      userId,
      name: "Deleting",
    });
    const { bot, send, post } = await webhookBot(defaultSpaceId);
    await system.space.update({ where: { id: defaultSpaceId }, data: { deletingAt: new Date() } });

    const response = await post({ post: { text: "Too late" } });

    expect(response.status).toBe(409);
    expect(await system.message.count({ where: { threadId: bot.thread!.id } })).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
