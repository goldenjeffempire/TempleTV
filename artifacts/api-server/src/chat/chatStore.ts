/**
 * Chat persistence layer.
 *
 * Wraps the drizzle ops the WS gateway and admin REST routes need. All
 * functions are intentionally narrow so the gateway can be unit-tested
 * against a faked store.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  chatMessagesTable,
  chatModerationTable,
  type ChatMessageRow,
  type ChatModerationRow,
} from "@workspace/db";
import type { ChatMessage } from "./types";

function rowToMessage(r: ChatMessageRow): ChatMessage {
  return {
    id: r.id,
    channelId: r.channelId,
    userId: r.userId,
    displayName: r.displayName,
    body: r.body,
    createdAtMs: r.createdAt.getTime(),
    broadcastItemId: r.broadcastItemId,
    broadcastItemTitle: r.broadcastItemTitle,
  };
}

export interface InsertMessageInput {
  channelId: string;
  userId: string | null;
  displayName: string;
  body: string;
  broadcastItemId: string | null;
  broadcastItemTitle: string | null;
  ipHash: string | null;
}

export async function insertMessage(input: InsertMessageInput): Promise<ChatMessage> {
  const id = randomUUID();
  const [row] = await db
    .insert(chatMessagesTable)
    .values({
      id,
      channelId: input.channelId,
      userId: input.userId,
      displayName: input.displayName,
      body: input.body,
      broadcastItemId: input.broadcastItemId,
      broadcastItemTitle: input.broadcastItemTitle,
      ipHash: input.ipHash,
    })
    .returning();
  return rowToMessage(row);
}

export async function fetchHistory(
  channelId: string,
  limit: number,
): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessagesTable)
    .where(
      and(
        eq(chatMessagesTable.channelId, channelId),
        isNull(chatMessagesTable.deletedAt),
      ),
    )
    .orderBy(desc(chatMessagesTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  // Return in chronological order so clients can append directly.
  return rows.reverse().map(rowToMessage);
}

export async function softDeleteMessage(
  messageId: string,
  deletedBy: string,
): Promise<{ deleted: boolean; channelId: string | null }> {
  const result = await db
    .update(chatMessagesTable)
    .set({ deletedAt: new Date(), deletedBy })
    .where(
      and(
        eq(chatMessagesTable.id, messageId),
        isNull(chatMessagesTable.deletedAt),
      ),
    )
    .returning({ id: chatMessagesTable.id, channelId: chatMessagesTable.channelId });
  if (result.length === 0) return { deleted: false, channelId: null };
  return { deleted: true, channelId: result[0].channelId };
}

export interface ModerationInput {
  subjectKind: "user" | "ip";
  subjectId: string;
  action: "mute" | "ban";
  reason: string | null;
  durationSecs: number | null;
  createdBy: string;
}

export async function applyModeration(
  input: ModerationInput,
): Promise<ChatModerationRow> {
  const id = randomUUID();
  const expiresAt =
    input.durationSecs && input.durationSecs > 0
      ? new Date(Date.now() + input.durationSecs * 1000)
      : null;
  const [row] = await db
    .insert(chatModerationTable)
    .values({
      id,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      action: input.action,
      reason: input.reason,
      expiresAt,
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}
