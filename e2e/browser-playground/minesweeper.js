/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* global document */

const board = document.querySelector('#mine-board')
const status = document.querySelector('#game-status')
const flagButton = document.querySelector('#flag-mode')
const seedInput = document.querySelector('#seed')
const cells = []
const state = { mines: new Set(), revealed: new Set(), flags: new Set(), started: false, ended: false, flagMode: false }

/** Return neighboring cell indexes without wrapping around the board edges. */
const neighbors = (index) => {
  const row = Math.floor(index / 9)
  const column = index % 9
  const result = []
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const y = row + dy
      const x = column + dx
      if ((dx || dy) && y >= 0 && y < 9 && x >= 0 && x < 9) result.push(y * 9 + x)
    }
  }
  return result
}

/** Place repeatable mines, leaving the first square and all its neighbors safe. */
const placeMines = (first) => {
  const safe = new Set([first, ...neighbors(first)])
  let seed = (Number(seedInput.value) || 42) >>> 0
  const available = Array.from({ length: 81 }, (_, index) => index).filter((index) => !safe.has(index))
  for (let i = available.length - 1; i > 0; i -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const j = seed % (i + 1)
    ;[available[i], available[j]] = [available[j], available[i]]
  }
  state.mines = new Set(available.slice(0, 10))
  state.started = true
}

/** Update visible state and labels without replacing the focused cell. */
const render = () => {
  cells.forEach((cell, index) => {
    const revealed = state.revealed.has(index)
    const mine = state.mines.has(index)
    const flagged = state.flags.has(index)
    const count = neighbors(index).filter((value) => state.mines.has(value)).length
    const shownMine = state.ended && mine
    cell.textContent = shownMine ? '✹' : flagged ? '⚑' : revealed && count ? String(count) : ''
    cell.className = `mine-cell${revealed ? ' revealed' : ''}${shownMine ? ' mine' : ''}`
    cell.dataset.number = revealed ? String(count) : ''
    cell.disabled = revealed || state.ended
    const description = shownMine ? 'mine' : flagged ? 'flagged' : revealed ? `${count} nearby mines` : 'hidden'
    cell.setAttribute('aria-label', `Row ${Math.floor(index / 9) + 1}, column ${(index % 9) + 1}: ${description}`)
  })
  document.querySelector('#mines-left').textContent = String(10 - state.flags.size)
  document.querySelector('#safe-left').textContent = String(71 - state.revealed.size)
  flagButton.setAttribute('aria-pressed', String(state.flagMode))
}

/** Toggle a flag without allowing a reveal or changing completed boards. */
const flag = (index) => {
  if (state.ended || state.revealed.has(index)) return
  if (state.flags.has(index)) state.flags.delete(index)
  else state.flags.add(index)
  render()
}

/** Reveal a square and flood open connected empty squares. */
const reveal = (index) => {
  if (state.ended || state.revealed.has(index) || state.flags.has(index)) return
  if (!state.started) placeMines(index)
  if (state.mines.has(index)) {
    state.ended = true
    status.textContent = 'You found a mine. Choose New game to try the same board again.'
    status.classList.add('error')
    render()
    return
  }
  const pending = [index]
  while (pending.length) {
    const next = pending.pop()
    if (state.revealed.has(next) || state.flags.has(next)) continue
    state.revealed.add(next)
    const nearby = neighbors(next)
    if (nearby.every((value) => !state.mines.has(value))) pending.push(...nearby)
  }
  state.ended = state.revealed.size === 71
  status.textContent = state.ended
    ? 'You cleared the field. All 71 safe squares revealed — you win!'
    : 'Good start. Follow the numbers to find the next safe square.'
  render()
}

for (let index = 0; index < 81; index += 1) {
  const cell = document.createElement('button')
  cell.type = 'button'
  cell.id = `mine-r${Math.floor(index / 9) + 1}-c${(index % 9) + 1}`
  cell.addEventListener('click', () => (state.flagMode ? flag(index) : reveal(index)))
  cell.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    flag(index)
  })
  cell.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'f') {
      event.preventDefault()
      flag(index)
    }
  })
  cells.push(cell)
  board.append(cell)
}
flagButton.addEventListener('click', () => {
  state.flagMode = !state.flagMode
  render()
})
document.querySelector('#new-game').addEventListener('click', () => {
  if (!seedInput.reportValidity()) return
  state.mines.clear()
  state.revealed.clear()
  state.flags.clear()
  state.started = false
  state.ended = false
  state.flagMode = false
  status.classList.remove('error')
  status.textContent = 'Pick any square. Your first reveal is always safe.'
  render()
})
render()
