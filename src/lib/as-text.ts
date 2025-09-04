import type { EmailMessage, EmailThread } from '@/types'

export const indentUserText = (text: string): string => {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
}

export const messageAsText = (message: EmailMessage) => {
  return `*At ${new Date(message.sentAt * 1000).toUTCString()} ${message.fromAddress} wrote:*
${indentUserText(message.textBody)}`
}

export const threadAsText = (thread: EmailThread, messages: EmailMessage[]) => {
  return `
Type: Email Thread
Subject: ${thread.subject}
Timespan: ${new Date(thread.firstMessageAt * 1000).toUTCString()} - ${new Date(thread.lastMessageAt * 1000).toUTCString()}
Messages:

${messages.map((message) => messageAsText(message)).join('\n\n')}
`
}
