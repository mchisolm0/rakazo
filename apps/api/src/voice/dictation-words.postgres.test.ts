import { randomBytes } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dictationWords } from "./dictation-words.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("dictation words (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const users: string[] = [];
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;

  beforeAll(() => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
  });

  afterAll(async () => {
    if (!db) return;
    await system.organization.deleteMany({
      where: { members: { some: { userId: { in: users } } } },
    });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function person(label: string) {
    const userId = `dictation-${label}-${suffix}`;
    users.push(userId);
    const name = `${label} Person`;
    await system.user.create({
      data: { id: userId, name, email: `${userId}@rakazo.test`, emailVerified: false },
    });
    const { spaceId } = await bootstrapUserSpace(system, { id: userId });
    return { userId, spaceId, name };
  }

  /** A bot owned by `userId` in `spaceId`, whose chat holds one message with `text`. */
  async function botChat(spaceId: string, userId: string, name: string, text: string) {
    const bot = await system.bot.create({ data: { spaceId, userId, name, color: "blue" } });
    const thread = await system.thread.create({ data: { spaceId, userId, botId: bot.id } });
    await system.message.create({
      data: { threadId: thread.id, seq: 1, role: "user", blocks: [{ kind: "text", text }] },
    });
  }

  it("lists only the actor's own bots, people in their Spaces, and links from their own chats", async () => {
    const me = await person("Me");
    const other = await person("Other");
    await botChat(me.spaceId, me.userId, "Ada", "Merged https://example.com/me/rakazo/pull/1");
    // Another person's bot and chat in the actor's Space, and in a Space the actor is not in.
    await botChat(me.spaceId, other.userId, "Bob", "See https://example.com/them/secret/pull/2");
    await botChat(other.spaceId, other.userId, "Cy", "See https://example.com/them/private/pull/3");

    const words = await dictationWords(prisma, {
      userId: me.userId,
      spaceId: me.spaceId,
    } as Actor);

    expect(words).toEqual(["rakazo", "Ada", me.name]);
  });
});
