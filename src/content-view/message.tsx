import { EmailAddressPreview } from '@/components/ContactPreview'
import { DatetimePreview } from '@/components/DatetimePreview'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { formatDate } from '@/lib/utils'
import { Fragment, useEffect, useState } from 'react'

// @todo re-implement types
export function EmailMessageView({ message, isOpen: defaultIsOpen = true }: { message: any; isOpen?: boolean }) {
  const [isOpen, setIsOpen] = useState(defaultIsOpen)

  useEffect(() => {
    setIsOpen(defaultIsOpen)
  }, [defaultIsOpen])

  return (
    <Card className="p-0">
      {isOpen ? (
        <>
          <CardContent className="p-0 border-b">
            <div className="px-6 py-4" onClick={() => setIsOpen(false)}>
              <Table>
                <TableBody className="[&_tr]:border-0 [&_tr:hover]:bg-transparent">
                  <TableRow>
                    <TableCell className="py-1 w-0 whitespace-nowrap font-bold">Date</TableCell>
                    <TableCell className="py-1 w-full">
                      <DatetimePreview timestamp={message.sentAt} />
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="py-1 w-0 whitespace-nowrap font-bold">From</TableCell>
                    <TableCell className="py-1 w-full">
                      <EmailAddressPreview emailAddress={message.sender} />
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="py-1 w-0 whitespace-nowrap font-bold">To</TableCell>
                    <TableCell className="py-1 w-full">
                      {message.recipients.map((recipient: any, index: number) => (
                        <Fragment key={recipient.address.address}>
                          <EmailAddressPreview emailAddress={recipient.address} />
                          {index < message.recipients.length - 1 && ', '}
                        </Fragment>
                      ))}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <Separator className="" />
            <div className="px-6 py-4">
              <p className="text-sm">{message.textBody || 'No message body'}</p>
            </div>
          </CardContent>
        </>
      ) : (
        <CardContent className="px-6 py-4" onClick={() => setIsOpen(true)}>
          <div className="flex justify-between items-center">
            <p className="text-sm m-0">{message.sender.name || message.sender.address}</p>
            <p className="text-sm text-muted-foreground m-0">{formatDate(message.sentAt)}</p>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
