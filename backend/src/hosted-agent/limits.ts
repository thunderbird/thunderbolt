/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Most tool calls one reply may make across its steps, so one message cannot fan out into a flood of calls. */
export const maxToolCallsPerReply = 20

/**
 * Most model steps `AGENT_MAX_STEPS` may allow: one per tool call the budget allows, plus the answer. A step that calls
 * no tool ends the reply, and the step after the budget is spent offers no tools, so a reply never takes more.
 */
export const maxAgentSteps = maxToolCallsPerReply + 1
