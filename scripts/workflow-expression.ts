/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type ExpressionContext = { [path: string]: string | number | boolean | null }

/**
 * Evaluates a workflow expression for tests. The ones under test only use syntax JS shares
 * (==, !=, !, &&, ||, quotes) plus the `cancelled()` status function.
 */
export const evaluate = (expression: string, context: ExpressionContext) => {
  const js = expression
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .replace(/\bcancelled\(\)/g, String(context['cancelled()'] ?? false))
    .replace(/\b(?:github|inputs|needs)(?:\.[\w-]+)+/g, (path) => JSON.stringify(context[path] ?? null))
  return new Function(`return ${js}`)()
}
