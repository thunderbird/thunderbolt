/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSocket } from 'node:dgram'
import { createServer } from 'node:http'

/**
 * A DNS server that answers TXT queries from records the specs register, so the admin backend
 * (`TEST_DNS_SERVERS`) can verify a `.test` domain through its real resolver. Any other name is
 * NXDOMAIN. Specs register a record with `PUT /txt {name, value}` on the control port; the specs run
 * in workers, so the record map must live here, in the global setup's process.
 */
export const createMockDns = async (dnsPort: number, controlPort: number) => {
  const records = new Map<string, string>()

  const dns = createSocket('udp4')
  dns.on('message', (query, sender) => {
    // The question starts after the 12-byte header: labels, then QTYPE and QCLASS.
    const labels: string[] = []
    let offset = 12
    while (query[offset]) {
      labels.push(query.subarray(offset + 1, offset + 1 + query[offset]).toString())
      offset += query[offset] + 1
    }
    const question = query.subarray(12, offset + 5)
    const value = records.get(labels.join('.').toLowerCase())

    const header = Buffer.alloc(12)
    query.copy(header, 0, 0, 2)
    header.writeUInt16BE(value === undefined ? 0x8183 : 0x8180, 2) // response, RD+RA, NXDOMAIN or NOERROR
    header.writeUInt16BE(1, 4)
    header.writeUInt16BE(value === undefined ? 0 : 1, 6)
    const answer = value === undefined ? Buffer.alloc(0) : txtAnswer(value)
    dns.send(Buffer.concat([header, question, answer]), sender.port, sender.address)
  })
  await new Promise<void>((resolve) => dns.bind(dnsPort, '127.0.0.1', resolve))

  const control = createServer(async (req, res) => {
    if (req.method !== 'PUT' || req.url !== '/txt') {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const { name, value } = JSON.parse(Buffer.concat(chunks).toString()) as { name: string; value: string }
    records.set(name.toLowerCase(), value)
    res.writeHead(204).end()
  })
  await new Promise<void>((resolve) => control.listen(controlPort, 'localhost', resolve))

  return {
    close: () => {
      dns.close()
      control.close()
    },
  }
}

/** One TXT answer for the question's name (a pointer to offset 12), as a single character-string. */
const txtAnswer = (value: string) => {
  const text = Buffer.from(value)
  const answer = Buffer.alloc(13 + text.length)
  answer.writeUInt16BE(0xc00c, 0)
  answer.writeUInt16BE(16, 2) // TXT
  answer.writeUInt16BE(1, 4) // IN
  answer.writeUInt32BE(0, 6) // TTL
  answer.writeUInt16BE(text.length + 1, 10)
  answer[12] = text.length
  text.copy(answer, 13)
  return answer
}
