// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
interface Window {
  isTauri?: boolean
  __TAURI__: {
    invoke: (cmd: string, args: any) => Promise<any>
  }
}
