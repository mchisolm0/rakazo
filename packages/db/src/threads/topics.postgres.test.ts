import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../database/client.js";
import { createDb } from "../database/client.js";
import { asSystem, runAsTenant } from "../database/row-security.js";
import { createThreadMessage } from "./messages.js";
import { markThreadReadFor } from "./thread-reads.js";
import { findTopic, listTopics, openTopic, postTopicItem, settleTopic } from "./topics.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

// Ada has an Inbox bot that posts reports as items, and a second bot whose chat is separate.
describePostgres("topics in a bot chat (PostgreSQL)", () => {
  const suffix = randomUUID();
  const ada = `topics-ada-${suffix}`;
  const organization = `topics-org-${suffix}`;
  const space = `topics-space-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let botId = "";
  let chatId = "";
  let otherChatId = "";
  let runId = "";

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const fixture = asSystem(prisma);
    const now = new Date();
    await fixture.user.create({
      data: { id: ada, name: "Ada", email: `${ada}@example.test`, emailVerified: false },
    });
    await fixture.organization.create({
      data: { id: organization, name: "Topics", slug: organization, createdAt: now },
    });
    await fixture.member.create({
      data: {
        id: randomUUID(),
        organizationId: organization,
        userId: ada,
        role: "owner",
        createdAt: now,
      },
    });
    await fixture.space.create({
      data: { id: space, organizationId: organization, name: "Topics" },
    });
    await fixture.spaceMember.create({
      data: {
        id: randomUUID(),
        organizationId: organization,
        spaceId: space,
        userId: ada,
        role: "owner",
        createdAt: now,
      },
    });
    const inbox = await fixture.bot.create({
      data: {
        spaceId: space,
        userId: ada,
        name: "Inbox",
        color: "blue",
        thread: { create: { spaceId: space, userId: ada } },
      },
      include: { thread: true },
    });
    const other = await fixture.bot.create({
      data: {
        spaceId: space,
        userId: ada,
        name: "Other",
        color: "green",
        thread: { create: { spaceId: space, userId: ada } },
      },
      include: { thread: true },
    });
    botId = inbox.id;
    chatId = inbox.thread!.id;
    otherChatId = other.thread!.id;
    const task = await fixture.task.create({
      data: { spaceId: space, botId, threadId: chatId, userId: ada, prompt: "", status: "running" },
    });
    runId = (
      await fixture.run.create({
        data: {
          spaceId: space,
          botId,
          threadId: chatId,
          taskId: task.id,
          userId: ada,
          status: "running",
          trigger: "routine",
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await asSystem(prisma).space.deleteMany({ where: { id: space } });
    await asSystem(prisma).organization.deleteMany({ where: { id: organization } });
    await asSystem(prisma).user.deleteMany({ where: { id: ada } });
    await close();
  });

  const as = <T>(fn: () => Promise<T>) => runAsTenant({ spaceId: space, userId: ada }, fn);
  const topics = (now?: Date) =>
    as(() => listTopics(prisma, { mainThreadId: chatId, userId: ada, now }));

  it("lists a posted item as open and unread before anyone replies, once per effect", async () => {
    const post = () =>
      as(() =>
        postTopicItem(prisma, {
          spaceId: space,
          mainThreadId: chatId,
          userId: ada,
          botId,
          runId,
          text: "**#412 Crash on launch**\niPad mini, 3 reports today.",
          effectKey: "effect-412",
        }),
      );
    const first = await post();
    const replay = await post();
    expect(replay.topicId).toBe(first.topicId);
    expect(replay.eventSeq).toBeNull();
    const [item] = await topics();
    expect(item).toMatchObject({
      id: first.topicId,
      rootMessageId: first.messageId,
      title: "#412 Crash on launch",
      item: true,
      replyCount: 0,
      unread: true,
      settledBy: null,
    });
  });

  it("starts a topic on open once, lists it only after a reply, and keeps it to its own chat", async () => {
    const root = await as(() =>
      createThreadMessage(prisma, {
        threadId: chatId,
        role: "bot",
        botId,
        blocks: [{ kind: "text", text: "Weekly summary" }],
      }),
    );
    const topicId = await as(() => openTopic(prisma, { mainThreadId: chatId, messageId: root.id }));
    expect(topicId).toBeTruthy();
    await expect(
      as(() => openTopic(prisma, { mainThreadId: chatId, messageId: root.id })),
    ).resolves.toBe(topicId);
    // A message from another chat cannot be opened through this one, nor its topic found.
    await expect(
      as(() => openTopic(prisma, { mainThreadId: otherChatId, messageId: root.id })),
    ).resolves.toBeNull();
    await expect(
      as(() => findTopic(prisma, { mainThreadId: otherChatId, topicId: topicId! })),
    ).resolves.toBeNull();
    expect((await topics()).some((topic) => topic.id === topicId)).toBe(false);

    await as(() =>
      createThreadMessage(prisma, {
        threadId: topicId!,
        role: "user",
        authorUserId: ada,
        blocks: [{ kind: "text", text: "Can you add last week's numbers?" }],
      }),
    );
    const listed = (await topics()).find((topic) => topic.id === topicId);
    expect(listed).toMatchObject({ title: "Weekly summary", item: false, replyCount: 1 });
  });

  it("settles by hand or from a quiet week once read, and a reopen restarts the week", async () => {
    const item = (await topics()).find((topic) => topic.item);
    const topicId = item!.id;
    // Unread, so a month of quiet still leaves it open.
    const later = new Date(Date.now() + 30 * DAY);
    expect((await topics(later)).find((topic) => topic.id === topicId)?.settledBy).toBeNull();

    await as(() => markThreadReadFor(prisma, { threadId: topicId, spaceId: space, userId: ada }));
    expect((await topics(later)).find((topic) => topic.id === topicId)?.settledBy).toBe("idle");

    await as(() => settleTopic(prisma, { topicId, by: "bot" }));
    expect((await topics()).find((topic) => topic.id === topicId)?.settledBy).toBe("bot");

    const reopenedAt = new Date(Date.now() + 10 * DAY);
    await as(() => settleTopic(prisma, { topicId, by: null, now: reopenedAt }));
    const soon = new Date(reopenedAt.getTime() + 3 * DAY);
    expect((await topics(soon)).find((topic) => topic.id === topicId)?.settledBy).toBeNull();
    const weekOn = new Date(reopenedAt.getTime() + 7 * DAY);
    expect((await topics(weekOn)).find((topic) => topic.id === topicId)?.settledBy).toBe("idle");
  });
});
