import { isTauri } from './platform'

// Only import Tauri APIs when in Tauri environment
let tauriPath: any = null
let tauriFs: any = null

// Lazy load Tauri modules only when needed
const loadTauriModules = async () => {
  if (isTauri() && !tauriPath) {
    try {
      tauriPath = await import('@tauri-apps/api/path')
      tauriFs = await import('@tauri-apps/plugin-fs')
    } catch (error) {
      console.error('Failed to load Tauri modules:', error)
    }
  }
}

export const createAppDataDir = async (): Promise<string> => {
  if (isTauri()) {
    // Tauri environment - use file system
    await loadTauriModules()

    if (!tauriPath || !tauriFs) {
      throw new Error('Failed to load Tauri filesystem modules')
    }

    const appDataDirPath = await tauriPath.appDataDir()

    await tauriFs.mkdir('data', { recursive: true, baseDir: tauriPath.BaseDirectory.AppData })
    console.log('App data directory initialized:', appDataDirPath)

    return appDataDirPath
  } else {
    // Web environment - use a virtual path for OPFS (SQLocal)
    const virtualPath = '/app-data'
    console.log('Web environment - using virtual app data path:', virtualPath)
    return virtualPath
  }
}
