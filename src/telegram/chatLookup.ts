import { deriveCapabilities } from "./capabilities";
import { TelegramClient } from "./client";
import { toResult } from "./errors";
import { listTasksForSourceChat } from "../db/queries";
import type { ChatLookupResult, Result } from "../shared/rpcTypes";

/** Shared chat inspection used by GET /api/chats/:chatId and the controller
 * bot's /chat command, so both report the same bot rights and history. */
export async function lookupChat(
  db: D1Database,
  client: TelegramClient,
  botTelegramId: number,
  chatId: string,
): Promise<Result<ChatLookupResult>> {
  return toResult(async (): Promise<ChatLookupResult> => {
    const chat = await client.getChat(chatId);
    const member = await client.getChatMember(chatId, botTelegramId);

    let memberCount = undefined;
    try {
      memberCount = await client.getChatMemberCount(chatId);
    } catch (e) {
      // ignore
    }

    let admins = undefined;
    try {
      const adminData = await client.getChatAdministrators(chatId);
      admins = adminData.map((a) => ({
        id: a.user.id,
        name: a.user.first_name + (a.user.username ? ` (@${a.user.username})` : ""),
        status: a.status,
        is_bot: a.user.is_bot,
      }));
    } catch (e) {
      // ignore
    }

    const pastTasks = await listTasksForSourceChat(db, [chatId, String(chat.id)]);

    return {
      chat: { id: chat.id, type: chat.type, title: chat.title, username: chat.username },
      botStatus: member.status,
      capabilities: deriveCapabilities(member, chat.type),
      memberCount,
      admins,
      pastTasks,
    };
  });
}
