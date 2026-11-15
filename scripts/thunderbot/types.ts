/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type TaskAssessment = {
  feasible: boolean
  confidence: number
  reasons: string[]
  complexity: 'trivial' | 'small' | 'medium' | 'large' | 'too-large'
  blockers: string[]
}

export type DaemonState = {
  activeTasks: string[]
  completedTasks: string[]
  skippedTasks: string[]
  lastPollAt: string | null
}

export type LinearIssue = {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number
  estimate: number | null
  state: { name: string }
  labels: { nodes: Array<{ name: string }> }
  children: { nodes: Array<{ id: string }> }
  assignee: { id: string; name: string } | null
  url: string
}
