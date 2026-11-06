/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { useForm } from 'react-hook-form'

import { Input } from './input'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from './form'

afterEach(cleanup)

const InvalidForm = () => {
  const form = useForm<{ apiKey: string }>({
    defaultValues: { apiKey: '' },
    errors: {
      apiKey: {
        type: 'required',
        message: 'API Key is required',
      },
    },
  })

  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="apiKey"
        render={({ field }) => (
          <FormItem>
            <FormLabel>API Key</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </Form>
  )
}

describe('Form validation', () => {
  it('uses the visible destructive color for invalid labels and messages', () => {
    render(<InvalidForm />)

    expect(screen.getByText('API Key')).toHaveClass('data-[error=true]:text-destructive')
    expect(screen.getByText('API Key is required')).toHaveClass('text-destructive')
  })
})
