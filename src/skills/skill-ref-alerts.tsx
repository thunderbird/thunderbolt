/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Link } from 'react-router'

/** One problematic slash reference in the user's current input. */
export type SkillRefProblem = { kind: 'disabled'; slug: string; skillId: string } | { kind: 'unknown'; slug: string }

/**
 * Inline alert strip rendered below the chat input. Surfaces tokens that
 * won't resolve at send time (skill disabled, or no skill by that name)
 * with a per-row remediation link for the disabled case.
 *
 * Returns `null` when there's nothing to alert about — caller doesn't need
 * to wrap with a conditional.
 *
 * The overlay above the textarea is `pointer-events-none`, so this strip
 * is the only actionable surface for fixing broken references — the
 * colored tokens up there are visual only.
 */
export const SkillRefAlerts = ({ problems }: { problems: SkillRefProblem[] }) => {
  if (problems.length === 0) {
    return null
  }

  return (
    <div role="alert" className="flex flex-col gap-1 text-[length:var(--font-size-sm)] text-muted-foreground">
      {problems.map((problem) =>
        problem.kind === 'disabled' ? (
          <div key={problem.slug} className="flex items-center gap-1">
            <span>
              <span className="font-medium text-foreground">/{problem.slug}</span> is disabled.
            </span>
            <Link
              to="/settings/skills"
              state={{ editSkill: problem.skillId }}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Enable
            </Link>
          </div>
        ) : (
          <div key={problem.slug} className="flex items-center gap-1">
            <span>
              No skill named <span className="font-medium text-foreground">/{problem.slug}</span>.
            </span>
            <Link
              to="/settings/skills"
              state={{ createSkill: problem.slug }}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Create it
            </Link>
          </div>
        ),
      )}
    </div>
  )
}
