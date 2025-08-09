interface Window {
  isTauri?: boolean
  __TAURI__: {
    invoke: (cmd: string, args: any) => Promise<any>
  }
}

declare module '@flwr/flwr' {
  interface FlowerIntelligence {
    baseUrl: string
    instance: FlowerIntelligence
  }

  const FlowerIntelligence: FlowerIntelligence
}
