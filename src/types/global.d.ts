/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface Window {
  isTauri?: boolean
  __TAURI__: {
    invoke: (cmd: string, args: any) => Promise<any>
  }
}

// Wa-sqlite ships `OPFSCoopSyncVFS` without .d.ts coverage. Imported
// statically by `src/db/wa-sqlite-worker.ts` and by
// `src/migrations/pre-workspaces-attach/legacy-reader.worker.ts`.
declare module '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js' {
  export class OPFSCoopSyncVFS {
    static create(name: string, module: unknown, options?: unknown): Promise<OPFSCoopSyncVFS>
  }
}
