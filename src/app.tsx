import { lazy } from 'react'
import { AppErrorScreen } from './components/app-error-screen'
import { useAppInitialization } from './hooks/use-app-initialization'
import Loading from './loading'

const AppContent = lazy(() => import('./app-content'))

export const App = () => {
  const { initData, initError, isInitializing, clearDatabase } = useAppInitialization()

  if (initError) {
    return <AppErrorScreen error={initError} isClearingDatabase={isInitializing} onClearDatabase={clearDatabase} />
  }

  if (!initData) {
    return <Loading />
  }

  return <AppContent initData={initData} />
}
