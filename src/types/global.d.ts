interface Window {
  isTauri?: boolean
  __TAURI__: {
    invoke: (cmd: string, args: any) => Promise<any>
  }
}
