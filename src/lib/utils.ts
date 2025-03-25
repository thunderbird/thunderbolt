import { ChatMessage, ParsedEmail, ParsedEmailHeader } from '@/types'
import { Message } from 'ai'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function uuidv7ToDate(uuid: string) {
  return new Date(parseInt(uuid.slice(0, 8), 16) * 1000)
}

export function convertDbChatMessageToMessage(message: ChatMessage): Message {
  return {
    id: message.id,
    parts: message.parts ?? undefined,
    role: message.role,
    content: message.content,
    createdAt: uuidv7ToDate(message.id),
    experimental_attachments: message.attachments ?? undefined,
    annotations: message.annotations ?? undefined,
  }
}

export function convertMessageToDbChatMessage(message: Message, chatThreadId: string): ChatMessage {
  return {
    id: message.id,
    parts: message.parts || [],
    role: message.role,
    content: message.content,
    chat_thread_id: chatThreadId,
    attachments: message.experimental_attachments ?? null,
    annotations: message.annotations ?? null,
  }
}

export function getHeadersFromParsedEmail(parsedEmail: ParsedEmail): ParsedEmailHeader[] {
  return parsedEmail.parts[0]?.headers ?? []
}

export function getSubjectFromParsedEmail(parsedEmail: ParsedEmail): string | undefined {
  return getHeadersFromParsedEmail(parsedEmail).find((header) => typeof header.name === 'string' && header.name.toLocaleLowerCase() === 'subject')?.value.Text
}

export function getMessageIdFromParsedEmail(parsedEmail: ParsedEmail): string | undefined {
  return getHeadersFromParsedEmail(parsedEmail).find((header) => typeof header.name === 'string' && header.name.toLocaleLowerCase() === 'message_id')?.value.Text
}

export function getFromFromParsedEmail(parsedEmail: ParsedEmail): string | undefined {
  return getHeadersFromParsedEmail(parsedEmail).find((header) => typeof header.name === 'string' && header.name.toLocaleLowerCase() === 'from')?.value.Text
}
