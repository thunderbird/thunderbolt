/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* global document, window, FormData, Element */

const form = document.querySelector('#workshop-form')
const status = document.querySelector('#form-status')
const receipt = document.querySelector('#receipt')
const journal = document.querySelector('#event-log')
let eventNumber = 0
let lastScroll = 0

/** Log event type and target, never typed values. */
const logEvent = (event) => {
  if (event.target instanceof Element && event.target.closest('#clear-journal')) return
  const target = event.target instanceof Element ? event.target.id || event.target.tagName.toLowerCase() : 'page'
  const entry = document.createElement('li')
  eventNumber += 1
  const source = document.createElement('span')
  source.className = event.isTrusted ? 'trusted' : ''
  source.textContent = event.isTrusted ? 'native' : 'script'
  entry.append(`${String(eventNumber).padStart(2, '0')} ${event.type} · ${target} · `, source)
  journal.prepend(entry)
  while (journal.children.length > 12) journal.lastElementChild.remove()
}
for (const type of ['click', 'input', 'change', 'keydown', 'submit']) document.addEventListener(type, logEvent, true)
window.addEventListener(
  'scroll',
  (event) => {
    if (Date.now() - lastScroll < 300) return
    lastScroll = Date.now()
    logEvent(event)
  },
  { passive: true },
)
document.querySelector('#clear-journal').addEventListener('click', () => {
  journal.replaceChildren()
  eventNumber = 0
})
document.querySelector('#enthusiasm').addEventListener('input', (event) => {
  document.querySelector('#enthusiasm-value').textContent = event.target.value
})
form.addEventListener('submit', (event) => {
  event.preventDefault()
  const data = new FormData(form)
  status.textContent = `You're on the list, ${data.get('name')}! Your practice reservation is complete.`
  receipt.textContent = [
    `Name: ${data.get('name')}`,
    `Email: ${data.get('email')}`,
    `Workshop: ${data.get('workshop')}`,
    `Guests: ${data.get('guests')}`,
    `Note: ${data.get('notes') || 'None'}`,
    `Enthusiasm: ${data.get('enthusiasm')} / 10`,
    `Reminder: ${data.has('reminder') ? 'Yes' : 'No'}`,
  ].join('\n')
  receipt.hidden = false
})
form.addEventListener('reset', () => {
  status.textContent = 'Ready when you are. Nothing will be sent anywhere.'
  receipt.hidden = true
  receipt.textContent = ''
  document.querySelector('#enthusiasm-value').textContent = '7'
})
const dialog = document.querySelector('#details-dialog')
document.querySelector('#open-details').addEventListener('click', () => dialog.showModal())
document.querySelector('#checkpoint').addEventListener('click', () => {
  document.querySelector('#checkpoint-status').textContent = 'Checkpoint collected. You made it all the way down!'
})
