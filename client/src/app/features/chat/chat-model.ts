export interface Member {
  id: string;
  username: string;
  name: string;
  color: string;
  role: 'admin' | 'member';
  lastReadSeq: number;
  online: boolean;
}

export interface ChatFile {
  id: string;
  name: string;
  mime: string;
  kind: 'image' | 'video' | 'audio' | 'pdf' | 'other';
  size: number;
}

export interface Message {
  seq: number;
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  replyTo: { id: string; senderId: string; text: string; deleted: boolean } | null;
  attachments: ChatFile[];
  reactions: { userId: string; emoji: string }[];
}

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  name: string;
  description: string;
  /** Changes whenever the group picture does; null without one. */
  imageVersion: string | null;
  createdAt: number;
  updatedAt: number;
  members: Member[];
  lastMessage: Message | null;
  unread: number;
}

/** Inserts or replaces by id, keeping the list in send order. */
export function upsertMessage(list: Message[], message: Message): Message[] {
  const at = list.findIndex((m) => m.id === message.id);
  if (at >= 0) {
    const next = [...list];
    next[at] = message;
    return next;
  }
  return [...list, message].sort((a, b) => a.seq - b.seq);
}

/** Adds fetched history without overwriting messages already updated live. */
export function mergeHistory(current: Message[], fetched: Message[]): Message[] {
  const known = new Set(current.map((m) => m.id));
  return [...current, ...fetched.filter((m) => !known.has(m.id))].sort((a, b) => a.seq - b.seq);
}

export const sortConversations = (list: Conversation[]): Conversation[] =>
  [...list].sort((a, b) => b.updatedAt - a.updatedAt);

export function titleOf(conversation: Conversation, myId: string): string {
  if (conversation.type === 'group') return conversation.name;
  return conversation.members.find((m) => m.id !== myId)?.name ?? 'Deleted user';
}

export function reactionGroups(message: Message, myId: string) {
  const groups = new Map<string, { emoji: string; count: number; mine: boolean }>();
  for (const { emoji, userId } of message.reactions) {
    const group = groups.get(emoji) ?? { emoji, count: 0, mine: false };
    group.count++;
    group.mine ||= userId === myId;
    groups.set(emoji, group);
  }
  return [...groups.values()];
}

export function preview(message: Message | null): string {
  if (!message) return 'No messages yet';
  if (message.deletedAt) return 'Message deleted';
  return message.text || (message.attachments.length ? `📎 ${message.attachments[0]!.name}` : '');
}
