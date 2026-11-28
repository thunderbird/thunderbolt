/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { Ask } from './display'
import type { AskData } from './lib'

const meta = {
  title: 'Widgets/Ask',
  component: Ask,
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
} satisfies Meta<typeof Ask>

export default meta
type Story = StoryObj<typeof meta>

const singleAnswer: AskData = {
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

const multipleAnswers: AskData = {
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

const noDesignatedAnswer: AskData = {
  mode: 'choice',
  prompt: 'What would you like to do next?',
  options: [
    { id: 'draft', text: 'Draft a reply to this thread' },
    { id: 'summarize', text: 'Summarize the conversation so far' },
    { id: 'schedule', text: 'Schedule a follow-up for tomorrow' },
    { id: 'archive', text: 'Archive and move on' },
  ],
}

const preferenceAnswers: AskData = {
  mode: 'choices',
  prompt: 'Which of these newsletters would you like to keep receiving?',
  options: [
    { id: 'product', text: 'Product updates' },
    { id: 'security', text: 'Security advisories' },
    { id: 'community', text: 'Community digest' },
    { id: 'events', text: 'Events & webinars' },
  ],
}

/** One designated answer — radio-style, graded on the tap. */
export const SingleAnswer: Story = { args: singleAnswer }

/** Multiple designated answers — checkbox-style, graded on Submit, all-or-nothing match. */
export const MultipleAnswers: Story = { args: multipleAnswers }

/** No designated answer — the pick shows first and Submit (Next mid-quiz) commits it; "Other…" hands it to the composer. */
export const NoDesignatedAnswer: Story = { args: noDesignatedAnswer }

/** No designated answer, multi-select — a preference/opinion question. */
export const PreferenceMultiSelect: Story = { args: preferenceAnswers }

/** A step inside a multi-question quiz — the wizard supplies the `‹ Question N of M ›` step control. */
export const SequenceStep: Story = {
  args: { ...singleAnswer, progress: { step: 2, total: 4 }, onPrevious: () => {}, onNext: () => {} },
}

/** An answered graded step revisited with ‹ — read-only, its result still showing. */
export const RevisitedGradedStep: Story = {
  args: {
    ...singleAnswer,
    initialSelectedIds: ['imap'],
    initialSubmitted: true,
    progress: { step: 1, total: 4 },
    onNext: () => {},
  },
}

/** An optional question in a sequence — Skip doesn't hold up the rest. */
export const OptionalStep: Story = {
  args: { ...preferenceAnswers, canSkip: true, progress: { step: 3, total: 4 }, onPrevious: () => {} },
}

/** The answered last step of a quiz — "See all answers" sits on the left of the action row. */
export const LastStepAnswered: Story = {
  args: {
    ...preferenceAnswers,
    initialSelectedIds: ['product'],
    initialSubmitted: true,
    progress: { step: 4, total: 4 },
    onPrevious: () => {},
    onReview: () => {},
  },
}
