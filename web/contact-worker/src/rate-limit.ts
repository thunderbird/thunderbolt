/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const hour = 60 * 60 * 1000
type Attempt = { ipHash: string; time: number }

/** One named object shares a rolling email budget across all Cloudflare locations. */
export class ContactRateLimiter implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const ipHash = request.headers.get('X-Contact-IP-Hash')!
    return this.state.storage.transaction(async (storage) => {
      const now = Date.now()
      const attempts = ((await storage.get<Attempt[]>('attempts')) ?? []).filter(({ time }) => time > now - hour)
      const fromIp = attempts.filter((attempt) => attempt.ipHash === ipHash)
      const blockedUntil = Math.max(
        fromIp.length >= 3 ? fromIp[0].time + hour : 0,
        attempts.length >= 30 ? attempts[0].time + hour : 0,
      )
      if (blockedUntil > now) {
        return new Response(null, {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil((blockedUntil - now) / 1000)) },
        })
      }
      // Reserve before sending, including provider failures. At most 30 records can exist.
      attempts.push({ ipHash, time: now })
      await storage.put('attempts', attempts)
      await storage.setAlarm(attempts[0].time + hour)
      return new Response(null, { status: 204 })
    })
  }

  async alarm(): Promise<void> {
    await this.state.storage.transaction(async (storage) => {
      const now = Date.now()
      const attempts = ((await storage.get<Attempt[]>('attempts')) ?? []).filter(({ time }) => time > now - hour)
      if (attempts.length === 0) {
        await storage.delete('attempts')
        await storage.deleteAlarm()
        return
      }
      await storage.put('attempts', attempts)
      await storage.setAlarm(attempts[0].time + hour)
    })
  }
}
