/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { checkMaestroFlow } from './maestro-flow'

const appId = 'net.thunderbird.thunderbolt.dev'

// Cases from the spike (Q6), then the edges of the raw-text scan and the limits.
test.each([
  ['- runScript: x.js', 'runScript'],
  ['- evalScript: ${1+1}', 'evalScript'],
  ['- tapOn: ${http.get("https://x")}', '${'],
  ['- inputText: ${EMAIL}', undefined], // EMAIL is passed by the harness
  ['- openLink: https://example.com', 'openLink'],
  ['- launchApp:\n    appId: com.apple.Preferences', 'appId'],
  ['- launchApp:\n    clearState: true', 'clearState'],
  ['- pressKey: Home', 'pressKey'],
  ['- runFlow:\n    file: /etc/hosts', 'file'],
  ['- runFlow:\n    when:\n      true: ${1}\n    commands: [back]', 'when'],
  ['- addMedia: [a.png]', 'addMedia'],
  ['- takeScreenshot: shot', 'takeScreenshot'],
  ['- extendedWaitUntil:\n    visible: Hi\n    timeout: 999999', 'timeout'],
  ['- tapOn: &a Hi\n- tapOn: *a', 'alias'],
  ['appId: com.evil\n---\n- back', 'appId'],
  ['appId: x\nenv:\n  A: b\n---\n- back', 'env'],
  ['- inputText: ${PASSWORD}', '${'],
  ['- tapOn: "Terms & *conditions*"\n- tapOn: Search locations.*\n- tapOn: Hi!', undefined],
  ["- tapOn: Don't\n- tapOn: &a x", 'alias'],
  ['- tapOn: !js x', 'tags'],
  ['- tapOn: {text: Hi, <<: {id: x}}', 'merge'],
  ['- tapOn: {text: Hi, "<<": {id: x}}', 'merge'],
  ['- inputText: |\n    hi', 'block'],
  ['- tapOn: "two\n    lines"', 'one line'],
  ['appId: x\n---\n- back\n---\n- back', 'documents'],
  ['- back\n...\n- back', 'document end'],
  ['- tapOn: {toString: x}', 'toString'],
  ['- back\r- &a\r  tapOn: x\r- *a', 'alias'], // Bun reads a lone \r as a line break
  ['- tapOn:\r    text: a\r    <<: {id: b}', 'merge'],
  ['- back\r\n- tapOn: Hi', undefined],
  ['- tapOn: "<<"', undefined],
  ['- repeat:\n    commands: [back]', 'times'], // Maestro 2.11 loops up to Int.MAX_VALUE without times
  ['- repeat:\n    times: 2\n    commands:\n      - retry:\n          commands: [back]', 'nested'],
  [
    '- retry:\n    commands:\n      - runFlow:\n          commands:\n            - repeat:\n                times: 2\n                commands: [back]',
    'nested',
  ],
  ['- repeat:\n    times: 11\n    commands: [back]', 'times'],
  ['- retry:\n    maxRetries: "2"\n    commands: [back]', 'maxRetries'],
  ['- tapOn:\n    below:\n      text: ${1}', 'below.text'],
  ['- runFlow:\n    when:\n      visible: Hi\n      platform: iOS\n    commands:\n      - pressKey: Enter', undefined],
  [
    'appId: net.thunderbird.thunderbolt.dev\nname: Sign in\n---\n- launchApp\n- stopApp: net.thunderbird.thunderbolt.dev',
    undefined,
  ],
])('%s', (source, problem) => {
  const result = checkMaestroFlow(source, { appId, vars: ['EMAIL'] })
  if (problem === undefined) expect(result).toMatchObject({ ok: true })
  else expect(result).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringContaining(problem)]) })
})

test('a problem names the path of the command', () => {
  expect(
    checkMaestroFlow('- back\n- retry:\n    commands:\n      - runFlow:\n          file: x.yaml', { appId }),
  ).toEqual({
    ok: false,
    problems: ['commands[1].retry.commands[0].runFlow.file: key not allowed'],
  })
})

test('a variable is refused when the harness passes none', () => {
  expect(checkMaestroFlow('- inputText: ${EMAIL}', { appId })).toMatchObject({ ok: false })
})

test('the output is our own serialization with our appId', () => {
  const result = checkMaestroFlow('- tapOn: "Continue"\n- waitForAnimationToEnd', { appId })
  expect(result).toEqual({
    ok: true,
    yaml: `appId: ${appId}\n---\n${Bun.YAML.stringify([{ tapOn: 'Continue' }, 'waitForAnimationToEnd'], null, 2)}`,
  })
})

test('nested commands under retry and repeat are checked too', () => {
  expect(
    checkMaestroFlow('- retry:\n    maxRetries: 2\n    commands:\n      - runScript: x.js', { appId }),
  ).toMatchObject({
    ok: false,
  })
  expect(checkMaestroFlow('- repeat:\n    times: 2\n    commands:\n      - openLink: x', { appId })).toMatchObject({
    ok: false,
  })
})
