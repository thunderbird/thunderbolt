/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { Quiz } from './display'
import type { QuizData } from './lib'

const meta = {
  title: 'widgets/quiz',
  component: Quiz,
  parameters: {
    layout: 'centered',
    viewport: { defaultViewport: 'responsive' },
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-xl px-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Quiz>

export default meta
type Story = StoryObj<typeof meta>

const singleAnswer: QuizData = {
  mode: 'single',
  prompt: 'Which protocol does Thunderbird use to send outgoing mail?',
  explanation: 'SMTP (Simple Mail Transfer Protocol) handles sending. IMAP and POP3 are for retrieving mail.',
  options: [
    { id: 'imap', text: 'IMAP' },
    { id: 'smtp', text: 'SMTP', isCorrect: true },
    { id: 'pop3', text: 'POP3' },
    { id: 'dav', text: 'CalDAV' },
  ],
}

const multipleAnswers: QuizData = {
  mode: 'multiple',
  prompt: 'Which of these are end-to-end encryption standards supported for email?',
  explanation: 'Both OpenPGP and S/MIME provide end-to-end encryption. TLS only secures transport.',
  options: [
    { id: 'pgp', text: 'OpenPGP', isCorrect: true },
    { id: 'smime', text: 'S/MIME', isCorrect: true },
    { id: 'tls', text: 'TLS (transport only)' },
    { id: 'base64', text: 'Base64 encoding' },
  ],
}

const noCorrectAnswer: QuizData = {
  mode: 'choice',
  prompt: 'What would you like to do next?',
  options: [
    { id: 'draft', text: 'Draft a reply to this thread' },
    { id: 'summarize', text: 'Summarize the conversation so far' },
    { id: 'schedule', text: 'Schedule a follow-up for tomorrow' },
    { id: 'archive', text: 'Archive and move on' },
  ],
}

/** One correct answer — radio-style, graded on "Check answer". */
export const SingleCorrectAnswer: Story = { args: singleAnswer }

/** Multiple correct answers — checkbox-style, all-or-nothing grading. */
export const MultipleCorrectAnswers: Story = { args: multipleAnswers }

/** No correct answer — an open prompt where the choice itself is the action. */
export const NoCorrectAnswer: Story = { args: noCorrectAnswer }
