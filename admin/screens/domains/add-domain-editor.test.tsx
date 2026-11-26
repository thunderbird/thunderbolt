/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import type { OrgDomain } from '@shared/admin-api'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { createAdminTestHarness, flush, type FakeReply } from '../../test-utils'
import { AddDomainEditor } from './add-domain-editor'
import { makeDomain } from './fixtures'

const renderEditor = (reply: FakeReply) => {
  const harness = createAdminTestHarness(() => reply)
  const props = {
    onAdded: mock((_: OrgDomain) => {}),
    onDirtyChange: mock((_: boolean) => {}),
    onClose: mock(() => {}),
  }
  render(<AddDomainEditor {...props} />, { wrapper: harness.wrapper })
  return { harness, props }
}

const submit = async (value: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: 'Domain' }), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  await flush()
}

describe('AddDomainEditor', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
  })

  it('adds the trimmed domain and hands back the new row', async () => {
    const added = makeDomain()
    const { harness, props } = renderEditor({ body: added })

    await submit('  example.com ')

    expect(harness.requests.find((request) => request.method === 'POST')).toMatchObject({
      method: 'POST',
      path: 'admin/domains',
      body: { domain: 'example.com' },
    })
    expect(props.onAdded).toHaveBeenCalledWith(added)
  })

  it('tracks whether there is a draft', () => {
    const { props } = renderEditor({})
    const input = screen.getByRole('textbox', { name: 'Domain' })

    fireEvent.change(input, { target: { value: 'a' } })
    fireEvent.change(input, { target: { value: ' ' } })

    expect(props.onDirtyChange.mock.calls).toEqual([[true], [false]])
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
  })

  it.each([
    ['INVALID_DOMAIN', "That isn't a valid domain."],
    ['DOMAIN_EXISTS', 'This domain has already been added.'],
  ])('shows %s under the field', async (code, message) => {
    const { props } = renderEditor({ status: 400, body: { code } })

    await submit('nope')

    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('textbox', { name: 'Domain' })).toHaveAttribute('aria-invalid', 'true')
    expect(props.onAdded).not.toHaveBeenCalled()
  })

  it('tells the admin that subdomains are added on their own, behind the info icon', async () => {
    renderEditor({})
    fireEvent.focus(screen.getByRole('button', { name: 'What is this for?' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent("Subdomains aren't included. Add each one separately.")
  })
})
