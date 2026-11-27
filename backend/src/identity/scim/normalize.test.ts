/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import {
  guardExternalIdPatch,
  guardExternalIdPut,
  requireExternalId,
  rewriteEmailValueFilters,
  stripUnsupportedExtensionOperations,
  stripUnsupportedExtensions,
} from './normalize'

const core = 'urn:ietf:params:scim:schemas:core:2.0:User'
const enterprise = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'
const custom = 'urn:ietf:params:scim:schemas:extension:CustomExtensionName:2.0:User'

describe('stripUnsupportedExtensions', () => {
  it('drops unknown extension schemas and their attributes, keeping core and enterprise', () => {
    expect(
      stripUnsupportedExtensions({
        schemas: [core, enterprise, custom],
        userName: 'ada',
        [enterprise]: { department: 'Finance' },
        [custom]: { costCenter: '42' },
      }),
    ).toEqual({ schemas: [core, enterprise], userName: 'ada', [enterprise]: { department: 'Finance' } })
  })

  it('leaves non-extension schema markers alone', () => {
    const legacy = 'http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group'
    expect(stripUnsupportedExtensions({ schemas: [legacy], displayName: 'Finance' })).toEqual({
      schemas: [legacy],
      displayName: 'Finance',
    })
  })
})

describe('stripUnsupportedExtensionOperations', () => {
  it('drops ops on unknown extension paths and such keys from pathless values', () => {
    expect(
      stripUnsupportedExtensionOperations([
        { op: 'Replace', path: `${custom}:costCenter`, value: '1' },
        { op: 'Replace', path: `${enterprise}:department`, value: 'Ops' },
        { op: 'Replace', value: { displayName: 'Ada', [custom]: { costCenter: '2' } } },
        { op: 'Replace', value: { [custom]: { costCenter: '3' } } },
      ]),
    ).toEqual([
      { op: 'Replace', path: `${enterprise}:department`, value: 'Ops' },
      { op: 'Replace', value: { displayName: 'Ada' } },
    ])
  })
})

describe('rewriteEmailValueFilters', () => {
  const emails = [
    { value: 'alice@example.com', type: 'work', primary: true },
    { value: 'alice@home.example', type: 'home' },
  ]

  it('rewrites a value-filtered address change into a replace of the whole list', () => {
    expect(
      rewriteEmailValueFilters(
        [
          { op: 'replace', path: 'emails[value eq "ALICE@example.com"].value', value: 'alice2@example.com' },
          { op: 'replace', path: 'userName', value: 'alice2' },
        ],
        emails,
      ),
    ).toEqual({
      operations: [
        {
          op: 'replace',
          path: 'emails',
          value: [{ value: 'alice2@example.com', type: 'work', primary: true }, emails[1]],
        },
        { op: 'replace', path: 'userName', value: 'alice2' },
      ],
    })
  })

  it('applies several filtered ops in order, and removes a filtered entry', () => {
    const result = rewriteEmailValueFilters(
      [
        { op: 'replace', path: 'emails[value eq "alice@example.com"].value', value: ['a@example.com'] },
        { op: 'remove', path: 'emails[value eq "alice@home.example"]' },
      ],
      emails,
    )
    expect(result).toEqual({
      operations: [
        { op: 'replace', path: 'emails', value: [{ ...emails[0], value: 'a@example.com' }, emails[1]] },
        { op: 'replace', path: 'emails', value: [{ ...emails[0], value: 'a@example.com' }] },
      ],
    })
  })

  it('merges sub-attributes for a filter without .value', () => {
    expect(
      rewriteEmailValueFilters(
        [{ op: 'replace', path: 'emails[value eq "alice@home.example"]', value: { type: 'other' } }],
        emails,
      ),
    ).toEqual({ operations: [{ op: 'replace', path: 'emails', value: [emails[0], { ...emails[1], type: 'other' }] }] })
  })

  it('refuses a filter that matches no stored address, or a replace without an address', () => {
    expect(
      rewriteEmailValueFilters([{ op: 'replace', path: 'emails[value eq "x@example.com"].value', value: 'y' }], emails),
    ).toMatchObject({ refusal: { scimType: 'noTarget' } })
    expect(
      rewriteEmailValueFilters(
        [{ op: 'replace', path: 'emails[value eq "alice@example.com"].value', value: 1 }],
        emails,
      ),
    ).toMatchObject({ refusal: { scimType: 'invalidValue' } })
  })

  it('sees addresses an earlier whole-list replace set', () => {
    const replaced = [{ value: 'new@example.com', type: 'work', primary: true }]
    expect(
      rewriteEmailValueFilters(
        [
          { op: 'replace', path: 'emails', value: replaced },
          { op: 'replace', path: 'emails[value eq "new@example.com"].value', value: 'newer@example.com' },
        ],
        emails,
      ),
    ).toEqual({
      operations: [
        { op: 'replace', path: 'emails', value: replaced },
        { op: 'replace', path: 'emails', value: [{ ...replaced[0], value: 'newer@example.com' }] },
      ],
    })
  })

  it('sees addresses an earlier pathless value or add set', () => {
    const pathless = rewriteEmailValueFilters(
      [
        { op: 'replace', value: { emails: [{ value: 'p@example.com', primary: true }] } },
        { op: 'remove', path: 'emails[value eq "alice@example.com"]' },
      ],
      emails,
    )
    expect(pathless).toMatchObject({ refusal: { scimType: 'noTarget' } })

    const added = rewriteEmailValueFilters(
      [
        { op: 'add', path: 'emails', value: [{ value: 'extra@example.com', type: 'other' }] },
        { op: 'remove', path: 'emails[value eq "extra@example.com"]' },
      ],
      emails,
    )
    expect(added).toMatchObject({ operations: [{}, { op: 'replace', path: 'emails', value: emails }] })
  })

  it('sees addresses earlier type and primary filters changed', () => {
    const result = rewriteEmailValueFilters(
      [
        { op: 'replace', path: 'emails[type eq "work"].value', value: 'w@example.com' },
        { op: 'replace', path: 'emails[primary eq true].value', value: 'p@example.com' },
        { op: 'replace', path: 'emails[value eq "p@example.com"].value', value: 'final@example.com' },
        { op: 'remove', path: 'emails[value eq "alice@home.example"]' },
      ],
      emails,
    )
    expect(result).toMatchObject({
      operations: [
        {},
        {},
        { op: 'replace', path: 'emails', value: [{ ...emails[0], value: 'final@example.com' }, emails[1]] },
        { op: 'replace', path: 'emails', value: [{ ...emails[0], value: 'final@example.com' }] },
      ],
    })
  })

  it('leaves the filters the plugin supports untouched', () => {
    const operations = [{ op: 'replace', path: 'emails[type eq "work"].value', value: 'b@example.com' }]
    expect(rewriteEmailValueFilters(operations, emails)).toEqual({ operations })
  })
})

describe('guardExternalIdPatch', () => {
  it('allows anything while no externalId is stored', () => {
    expect(guardExternalIdPatch([{ op: 'add', path: 'externalId', value: 'new' }], undefined)).toBeUndefined()
  })

  it('allows setting the stored value again', () => {
    expect(guardExternalIdPatch([{ op: 'Add', path: 'externalId', value: 'kc-1' }], 'kc-1')).toBeUndefined()
    expect(guardExternalIdPatch([{ op: 'replace', value: { externalId: 'kc-1' } }], 'kc-1')).toBeUndefined()
  })

  it('refuses a change, a removal, a prefixed path and a pathless change', () => {
    for (const operation of [
      { op: 'replace', path: 'externalId', value: 'other' },
      { op: 'remove', path: 'externalId' },
      { op: 'replace', path: `${core}:externalId`, value: 'other' },
      { op: 'replace', value: { externalId: 'other' } },
    ]) {
      expect(guardExternalIdPatch([operation], 'kc-1')).toMatchObject({ scimType: 'mutability' })
    }
  })
})

describe('guardExternalIdPatch: bypasses', () => {
  it('treats a blank path as pathless, as the plugin does', () => {
    for (const path of ['', '   ']) {
      expect(guardExternalIdPatch([{ op: 'replace', path, value: { externalId: 'other' } }], 'kc-1')).toMatchObject({
        scimType: 'mutability',
      })
    }
  })

  it('refuses when any spelling differs, not only the first one found', () => {
    for (const value of [
      { externalId: 'kc-1', [`${core}:externalId`]: 'other' },
      { externalId: 'kc-1', ExternalId: 'other' },
      { externalId: 'kc-1', [core]: { externalId: 'other' } },
      { [core.toLowerCase()]: { ExternalId: 'other' } },
    ]) {
      expect(guardExternalIdPatch([{ op: 'replace', value }], 'kc-1')).toMatchObject({ scimType: 'mutability' })
    }
  })

  it('checks a value set on the core schema path itself', () => {
    expect(guardExternalIdPatch([{ op: 'replace', path: core, value: { externalId: 'other' } }], 'kc-1')).toMatchObject(
      { scimType: 'mutability' },
    )
    expect(guardExternalIdPatch([{ op: 'replace', path: core, value: { externalId: 'kc-1' } }], 'kc-1')).toBeUndefined()
  })
})

describe('blank paths elsewhere', () => {
  it('reads a blank path as pathless when stripping extensions', () => {
    expect(
      stripUnsupportedExtensionOperations([{ op: 'replace', path: ' ', value: { [custom]: { costCenter: '1' } } }]),
    ).toEqual([])
  })
})

describe('guardExternalIdPut', () => {
  it('refuses when any spelling in the replace differs', () => {
    for (const resource of [
      { userName: 'ada', externalId: 'kc-1', [`${core}:externalId`]: 'other' },
      { userName: 'ada', ExternalId: 'other' },
      { userName: 'ada', [core]: { externalId: 'other' } },
      { userName: 'ada', externalId: 'kc-1', ExternalId: null },
    ]) {
      expect(guardExternalIdPut(resource, 'kc-1')).toMatchObject({ refusal: { scimType: 'mutability' } })
    }
  })

  it('replaces a null externalId under any spelling with the stored value', () => {
    expect(guardExternalIdPut({ userName: 'ada', ExternalId: null }, 'kc-1')).toEqual({
      resource: { userName: 'ada', externalId: 'kc-1' },
    })
  })

  it('keeps the stored value when the replace leaves it out, and refuses a different one', () => {
    expect(guardExternalIdPut({ userName: 'ada' }, 'kc-1')).toEqual({
      resource: { userName: 'ada', externalId: 'kc-1' },
    })
    expect(guardExternalIdPut({ userName: 'ada', externalId: 'kc-1' }, 'kc-1')).toEqual({
      resource: { userName: 'ada', externalId: 'kc-1' },
    })
    expect(guardExternalIdPut({ userName: 'ada', externalId: 'kc-2' }, 'kc-1')).toMatchObject({
      refusal: { scimType: 'mutability' },
    })
  })
})

describe('requireExternalId', () => {
  it('refuses a missing or blank externalId', () => {
    expect(requireExternalId({ userName: 'ada' })).toMatchObject({ scimType: 'invalidValue' })
    expect(requireExternalId({ userName: 'ada', externalId: '  ' })).toMatchObject({ scimType: 'invalidValue' })
    expect(requireExternalId({ userName: 'ada', externalId: 'kc-1' })).toBeUndefined()
  })
})
