/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* global document */

const puzzle = '530070000600195000098000060800060003400803001700020006060000280000419005000080079'
const solution = '534678912672195348198342567859761423426853791713924856961537284287419635345286179'
const board = document.querySelector('#sudoku-board')
const status = document.querySelector('#puzzle-status')
const cells = []
let selected = null

/** Recount progress and recognize a solved board after each edit. */
const updateProgress = () => {
  const filled = cells.filter((cell) => !cell.readOnly && cell.value).length
  document.querySelector('#filled-count').textContent = `${filled} / 51`
  const solved = cells.every((cell, index) => cell.value === solution[index])
  status.classList.remove('error')
  status.textContent = solved
    ? 'Beautifully done. Every row, column, and box is complete — you win!'
    : `${51 - filled} squares to go. Take your time.`
}

/** Enter a single digit in the last selected editable square. */
const enterNumber = (value) => {
  if (!selected || selected.readOnly) {
    status.textContent = 'Select a white square first.'
    return
  }
  selected.value = value
  selected.classList.remove('conflict')
  selected.removeAttribute('aria-invalid')
  selected.focus()
  updateProgress()
}

for (let index = 0; index < 81; index += 1) {
  const cell = document.createElement('input')
  const given = puzzle[index] !== '0'
  cell.type = 'text'
  cell.inputMode = 'numeric'
  cell.maxLength = 1
  cell.autocomplete = 'off'
  cell.id = `sudoku-r${Math.floor(index / 9) + 1}-c${(index % 9) + 1}`
  cell.className = `sudoku-cell${given ? ' given' : ''}`
  cell.readOnly = given
  cell.value = given ? puzzle[index] : ''
  cell.setAttribute(
    'aria-label',
    `Row ${Math.floor(index / 9) + 1}, column ${(index % 9) + 1}${given ? `, given ${puzzle[index]}` : ''}`,
  )
  cell.addEventListener('focus', () => {
    selected = cell
    cell.select()
  })
  cell.addEventListener('click', () => cell.select())
  cell.addEventListener('input', () => {
    cell.value = cell.value.replace(/[^1-9]/g, '').slice(-1)
    cell.classList.remove('conflict')
    cell.removeAttribute('aria-invalid')
    updateProgress()
  })
  cell.addEventListener('keydown', (event) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -9, ArrowDown: 9 }[event.key]
    if (offset !== undefined) {
      event.preventDefault()
      cells[Math.max(0, Math.min(80, index + offset))].focus()
    } else if (event.key === 'Escape') cell.blur()
  })
  cells.push(cell)
  board.append(cell)
}
for (let value = 1; value <= 9; value += 1) {
  const button = document.createElement('button')
  button.className = 'button'
  button.textContent = String(value)
  button.setAttribute('aria-label', `Enter ${value}`)
  button.addEventListener('click', () => enterNumber(String(value)))
  document.querySelector('#number-pad').append(button)
}
document.querySelector('#erase-cell').addEventListener('click', () => enterNumber(''))
document.querySelector('#reset-puzzle').addEventListener('click', () => {
  cells.forEach((cell) => {
    if (!cell.readOnly) cell.value = ''
    cell.classList.remove('conflict')
    cell.removeAttribute('aria-invalid')
  })
  updateProgress()
  status.textContent = 'Fresh start. Select an empty square and enter a number.'
})
document.querySelector('#check-puzzle').addEventListener('click', () => {
  const incorrect = cells.filter((cell, index) => {
    const wrong = cell.value !== '' && cell.value !== solution[index]
    cell.classList.toggle('conflict', wrong)
    cell.setAttribute('aria-invalid', String(wrong))
    return wrong
  }).length
  if (incorrect) {
    status.classList.add('error')
    status.textContent = `${incorrect} ${incorrect === 1 ? 'entry needs' : 'entries need'} another look. Incorrect entries are highlighted.`
    return
  }
  updateProgress()
  if (cells.some((cell) => !cell.value)) status.textContent = 'All your entries are correct so far. Keep going!'
})
