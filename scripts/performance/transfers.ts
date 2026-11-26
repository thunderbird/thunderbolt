/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type Transfer = {
  url: string
  type: string
  status?: number
  networkStatus?: number
  contentEncoding?: string | null
  cacheControl?: string | null
  fromDiskCache?: boolean
  fromServiceWorker?: boolean
  fromCache?: boolean
  networkEncodedBytes?: number
  failure?: string
}

type Response = {
  status: number
  headers: Record<string, string>
  encodedDataLength?: number
  fromDiskCache?: boolean
  fromServiceWorker?: boolean
}
type Hop = { transfer: Transfer; expectsExtraInfo?: boolean }
type Request = { hops: Hop[]; extraStatuses: number[] }

/** Preserve redirect hops and correlate cache status even when CDP extra-info precedes its response event. */
export const createTransferRecorder = () => {
  const requests = new Map<string, Request>()
  const transfers: Transfer[] = []
  const requestFor = (id: string) => {
    const request = requests.get(id) ?? { hops: [], extraStatuses: [] }
    requests.set(id, request)
    return request
  }
  const assignStatuses = (request: Request) => {
    for (const hop of request.hops) {
      if (hop.expectsExtraInfo === undefined) {
        break
      }
      if (hop.expectsExtraInfo && hop.transfer.networkStatus === undefined && request.extraStatuses.length) {
        hop.transfer.networkStatus = request.extraStatuses.shift()
      }
    }
  }
  const applyResponse = (hop: Hop, response: Response, expectsExtraInfo: boolean) => {
    const headers = Object.fromEntries(
      Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]),
    )
    hop.expectsExtraInfo = expectsExtraInfo
    Object.assign(hop.transfer, {
      status: response.status,
      contentEncoding: headers['content-encoding'] ?? null,
      cacheControl: headers['cache-control'] ?? null,
      fromDiskCache: response.fromDiskCache ?? false,
      fromServiceWorker: response.fromServiceWorker ?? false,
    })
  }
  return {
    request: (event: {
      requestId: string
      request: { url: string }
      type?: string
      redirectResponse?: Response
      redirectHasExtraInfo?: boolean
    }) => {
      const request = requestFor(event.requestId)
      const previous = request.hops.at(-1)
      if (previous && event.redirectResponse) {
        applyResponse(previous, event.redirectResponse, event.redirectHasExtraInfo ?? false)
        previous.transfer.networkEncodedBytes = event.redirectResponse.encodedDataLength
      }
      const transfer = { url: event.request.url, type: event.type ?? 'Other' }
      request.hops.push({ transfer })
      transfers.push(transfer)
      assignStatuses(request)
    },
    response: (event: { requestId: string; response: Response; hasExtraInfo: boolean }) => {
      const request = requestFor(event.requestId)
      const hop = request.hops.at(-1)
      if (hop) {
        applyResponse(hop, event.response, event.hasExtraInfo)
        assignStatuses(request)
      }
    },
    extraInfo: ({ requestId, statusCode }: { requestId: string; statusCode: number }) => {
      const request = requestFor(requestId)
      request.extraStatuses.push(statusCode)
      assignStatuses(request)
    },
    cached: ({ requestId }: { requestId: string }) => {
      const hop = requestFor(requestId).hops.at(-1)
      if (hop) {
        hop.transfer.fromCache = true
      }
    },
    finished: ({ requestId, encodedDataLength }: { requestId: string; encodedDataLength: number }) => {
      const hop = requestFor(requestId).hops.at(-1)
      if (hop) {
        hop.transfer.networkEncodedBytes = encodedDataLength
      }
    },
    failed: ({ requestId, errorText }: { requestId: string; errorText: string }) => {
      const hop = requestFor(requestId).hops.at(-1)
      if (hop) {
        hop.transfer.failure = errorText
      }
    },
    snapshot: () => transfers.map((transfer) => ({ ...transfer })),
  }
}
