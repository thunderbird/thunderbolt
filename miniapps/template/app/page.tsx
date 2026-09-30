'use client'

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A small order book — the starter app.
 *
 * Deliberately a real thing rather than three buttons wired to a counter
 * (THU-909). The bridge is the point of this template, and a list of `Alpha /
 * Bravo / Charlie` showed the plumbing while hiding what the plumbing is *for*:
 * a mutating tool that needs approval, a read-only one that doesn't, context
 * worth publishing, and rows worth pointing at. It is still one file and one
 * `useState`.
 *
 * Replace the orders with your own state and the tools with your own verbs.
 */

import { useThunderbolt, type ThunderboltTool } from '@thunderbolt/miniapp-sdk'
import { useEffect, useMemo, useState } from 'react'

type OrderStatus = 'open' | 'filled' | 'cancelled'

type Order = {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  quantity: number
  price: number
  status: OrderStatus
}

const initialOrders: Order[] = [
  { id: 'A-1041', symbol: 'NVDA', side: 'buy', quantity: 250, price: 118.4, status: 'open' },
  { id: 'A-1042', symbol: 'MSFT', side: 'sell', quantity: 80, price: 431.15, status: 'open' },
  { id: 'A-1043', symbol: 'TSLA', side: 'buy', quantity: 120, price: 244.9, status: 'filled' },
  { id: 'A-1044', symbol: 'AMD', side: 'sell', quantity: 400, price: 162.05, status: 'open' },
  { id: 'A-1045', symbol: 'NVDA', side: 'sell', quantity: 60, price: 121.8, status: 'cancelled' },
]

const statuses: OrderStatus[] = ['open', 'filled', 'cancelled']

/*
 * Grouped by hand rather than through `Intl.NumberFormat`: this renders on the
 * server and again in the browser, and ICU separator output has changed between
 * versions, which React reports as a hydration mismatch and then silently keeps
 * the server's string.
 */
const money = (value: number) => `$${value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d)\.)/g, ',')}`

const Page = () => {
  const [orders, setOrders] = useState<Order[]>(initialOrders)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = orders.find((order) => order.id === selectedId) ?? null
  const open = orders.filter((order) => order.status === 'open')
  const exposure = open.reduce((total, order) => total + order.quantity * order.price, 0)

  /*
   * `tools` is read through a ref inside the hook, so rebuilding this array
   * every render costs nothing — but memoising keeps it out of effect
   * dependencies.
   *
   * The two annotations are the thing to copy. `set_order_status` changes data,
   * so it omits `readOnlyHint` and Thunderbolt asks the user before running it.
   * `summarise_book` only reads, so it declares `readOnlyHint: true` and runs
   * straight through. Only your app knows which of those a tool is.
   */
  const tools = useMemo<ThunderboltTool[]>(
    () => [
      {
        name: 'set_order_status',
        description:
          'Fill or cancel one order by its id. Use this when the user asks to act on an order rather than describing what would happen.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Order id, e.g. "A-1041".' },
            status: { type: 'string', enum: statuses, description: 'The status to set.' },
          },
          required: ['id', 'status'],
        },
        annotations: { readOnlyHint: false, title: 'Change an order status' },
        // `args` is typed `never` on the contract, so the implementer names its
        // shape here rather than casting inside the body.
        execute: ({ id, status }: { id: string; status: OrderStatus }) => {
          const order = initialOrders.find((entry) => entry.id === id)
          if (!order) {
            return `No order ${id}. Ids are ${initialOrders.map((entry) => entry.id).join(', ')}.`
          }
          if (!statuses.includes(status)) {
            return `"${status}" is not a status. Use one of ${statuses.join(', ')}.`
          }
          setOrders((current) => current.map((entry) => (entry.id === id ? { ...entry, status } : entry)))
          setSelectedId(id)
          return `${id} (${order.side} ${order.quantity} ${order.symbol}) is now ${status}.`
        },
      },
      {
        name: 'summarise_book',
        description: 'Read back every order with its status, plus the open exposure. Call this before quoting numbers.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        annotations: { readOnlyHint: true, title: 'Summarise the book' },
        execute: () =>
          [
            `${orders.length} orders, ${open.length} still open, open exposure ${money(exposure)}.`,
            ...orders.map(
              (order) =>
                `${order.id}: ${order.side} ${order.quantity} ${order.symbol} at ${money(order.price)} — ${order.status}.`,
            ),
          ].join(' '),
      },
    ],
    [orders, open.length, exposure],
  )

  const { connected, hostContext, sendContext } = useThunderbolt('Order Book', tools)

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
      title: selected ? `Order Book — ${selected.id}` : 'Order Book',
      summary: [
        `${orders.length} orders, ${open.length} open, open exposure ${money(exposure)}.`,
        selected
          ? `${selected.id} is selected: ${selected.side} ${selected.quantity} ${selected.symbol} at ${money(selected.price)}, ${selected.status}.`
          : 'No order is selected.',
      ].join(' '),
      data: { orders, selectedId, openExposure: exposure },
      selection: selected ?? undefined,
    })
  }, [connected, orders, selected, selectedId, open.length, exposure, sendContext])

  const setSelectedStatus = (status: OrderStatus) => {
    if (!selectedId) {
      return
    }
    setOrders((current) => current.map((entry) => (entry.id === selectedId ? { ...entry, status } : entry)))
  }

  return (
    <main>
      <header>
        <h1>Order Book</h1>
        <span className="status">{connected ? 'Connected to Thunderbolt' : 'Running standalone'}</span>
      </header>
      <p className="lede">
        {open.length} of {orders.length} open · exposure {money(exposure)}
      </p>

      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Symbol</th>
            <th>Side</th>
            <th className="num">Qty</th>
            <th className="num">Price</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr
              key={order.id}
              aria-selected={order.id === selectedId}
              onClick={() => setSelectedId(order.id === selectedId ? null : order.id)}
              /* `data-tb-select` marks a row as pointable, so the user can
                 point at one and ask about it. `data-tb-label` is what the
                 model is told they pointed at. */
              data-tb-select
              data-tb-label={`${order.id}: ${order.side} ${order.quantity} ${order.symbol} at ${money(order.price)}, ${order.status}`}
            >
              <td>{order.id}</td>
              <td>{order.symbol}</td>
              <td className={order.side === 'buy' ? 'side-buy' : 'side-sell'}>{order.side}</td>
              <td className="num">{order.quantity}</td>
              <td className="num">{money(order.price)}</td>
              <td>
                <span className={`pill pill-${order.status}`}>{order.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="actions">
        <button type="button" className="primary" disabled={!selected} onClick={() => setSelectedStatus('filled')}>
          Fill
        </button>
        <button type="button" disabled={!selected} onClick={() => setSelectedStatus('cancelled')}>
          Cancel
        </button>
        <button type="button" disabled={!selected} onClick={() => setSelectedStatus('open')}>
          Reopen
        </button>
        <button type="button" disabled={!selected} onClick={() => setSelectedId(null)}>
          Clear selection
        </button>
      </div>

      <p className="hint">
        {connected
          ? 'Pick a row, then use the Chat button to ask about it. The assistant can fill or cancel an order — it will ask you first.'
          : 'Open this app inside Thunderbolt to reach the assistant.'}
      </p>
    </main>
  )
}

export default Page
