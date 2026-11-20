import type { PrismaClient } from "../database/client.js";
import { Prisma } from "../database/client.js";
import { contentEncryptionOf } from "../encryption/content-encryption.js";

/** Scalar columns a sidebar row reads from its thread's newest message. */
export interface SidebarPreviewMessage {
  id: string;
  threadId: string;
  seq: number;
  role: string;
  blocks: Prisma.JsonValue;
  botId: string | null;
  replyToMessageId: string | null;
  replyQuote: string | null;
  runId: string | null;
  clientNonce: string | null;
  createdAt: Date;
}

/**
 * One indexed read of the newest `limit` messages per thread. A nested `take`
 * on `findMany` is applied in memory and would load every message.
 */
export async function withNewestThreadMessages<T extends { thread: { id: string } | null }>(
  prisma: PrismaClient,
  parents: T[],
  limit: number,
) {
  const threadIds = parents.flatMap((parent) => (parent.thread ? [parent.thread.id] : []));
  const loaded =
    threadIds.length === 0
      ? []
      : await prisma.$queryRaw<SidebarPreviewMessage[]>(Prisma.sql`
          SELECT m.id, m."threadId", m.seq, m.role, m.blocks, m."botId",
            m."replyToMessageId", m."replyQuote", m."runId", m."clientNonce", m."createdAt"
          FROM unnest(${threadIds}::text[]) AS t(id)
          CROSS JOIN LATERAL (
            SELECT id, "threadId", seq, role, blocks, "botId", "replyToMessageId", "replyQuote",
              "runId", "clientNonce", "createdAt"
            FROM messages
            WHERE "threadId" = t.id
            ORDER BY seq DESC
            LIMIT ${limit}
          ) m
          ORDER BY m."threadId", m.seq DESC
        `);
  const opened = (await contentEncryptionOf(prisma)?.openRows("Message", loaded)) ?? loaded;
  const byThread = new Map<string, SidebarPreviewMessage[]>();
  for (const row of opened) {
    const list = byThread.get(row.threadId);
    if (list) list.push(row);
    else byThread.set(row.threadId, [row]);
  }
  return parents.map((parent) => ({
    ...parent,
    thread: parent.thread
      ? { ...parent.thread, messages: byThread.get(parent.thread.id) ?? [] }
      : null,
  }));
}

/**
 * The newest `perThread` messages of the `threadCount` threads written to most recently, in two
 * indexed reads, so neither a long history nor many quiet threads makes the read slow.
 */
export async function newestMessagesOfActiveThreads(
  prisma: PrismaClient,
  threadIds: string[],
  threadCount: number,
  perThread: number,
): Promise<SidebarPreviewMessage[]> {
  if (threadIds.length === 0) return [];
  const active = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT t.id
    FROM unnest(${threadIds}::text[]) AS t(id)
    CROSS JOIN LATERAL (
      SELECT "createdAt" FROM messages WHERE "threadId" = t.id ORDER BY seq DESC LIMIT 1
    ) m
    ORDER BY m."createdAt" DESC
    LIMIT ${threadCount}
  `);
  const loaded = await withNewestThreadMessages(
    prisma,
    active.map((row) => ({ thread: { id: row.id } })),
    perThread,
  );
  return loaded.flatMap((row) => row.thread?.messages ?? []);
}
