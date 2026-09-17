'use client'

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useThunderbolt, type ThunderboltTool } from '@thunderbolt/miniapp-sdk'
import { useEffect, useMemo, useState } from 'react'

/** Replace with your app's own state. Kept trivial so the bridge is the only thing on show. */
const items = ['Alpha', 'Bravo', 'Charlie']

const Page = () => {
  const [selected, setSelected] = useState<string | null>(null)

  // `tools` is read through a ref inside the hook, so rebuilding this array each
  // render costs nothing — but memoising keeps it out of effect dependencies.
  const tools = useMemo<ThunderboltTool[]>(
    () => [
      {
        name: 'select_item',
        description: 'Select one of the listed items by name.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Item to select' } },
          required: ['name'],
        },
        // `false` because it mutates: a tool without `readOnlyHint: true`
        // prompts the user before running, which is the safe default. Only your
        // app knows whether a tool changes anything, so this is your call.
        annotations: { readOnlyHint: false, title: 'Select an item' },
        // `args` is typed `never` on the contract so the implementer names its
        // shape here rather than casting inside the body.
        execute: ({ name }: { name: string }) => {
          if (!items.includes(name)) {
            return `"${name}" is not one of the items.`
          }
          setSelected(name)
          return `Selected ${name}.`
        },
      },
    ],
    [],
  )

  const { connected, hostContext, sendContext } = useThunderbolt('Mini App', tools)

  // Writing to documentElement is a side effect on something outside React's
  // tree, which is what useEffect is actually for.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', hostContext.theme)
  }, [hostContext.theme])

  // Publishing to the host is an external subscription, not a parent
  // notification — the chat reads whatever was last sent.
  useEffect(() => {
    if (!connected) {
      return
    }
    sendContext({
      title: selected ? `Mini App — ${selected}` : 'Mini App',
      summary: selected ? `${selected} is selected.` : 'Nothing is selected yet.',
      data: { items, selected },
    })
  }, [connected, selected, sendContext])

  return (
    <main>
      <h1>Mini App</h1>
      <p>{connected ? 'Connected to Thunderbolt.' : 'Running standalone.'}</p>
      <ul>
        {items.map((item) => (
          <li key={item}>
            <button type="button" aria-pressed={selected === item} onClick={() => setSelected(item)}>
              {item}
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}

export default Page
