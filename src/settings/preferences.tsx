/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth, useDatabase } from '@/contexts'
import { useSignInModal } from '@/contexts/sign-in-modal-context'
import { exportUserData, importUserData, summarizeExportEnvelope, type ExportSummary } from '@/dal'
import { downloadJson, exportFilenameFor } from '@/lib/export-download'
import { readJsonFile } from '@/lib/import-upload'
import { useLocalStorage } from '@/hooks/use-local-storage'
import type { LocationData } from '@/hooks/use-location-search'
import { updateSettings } from '@/dal'
import { useSettings } from '@/hooks/use-settings'
import { initialLocalSettings, useLocalSettingsStore } from '@/stores/local-settings-store'
import { privacyPolicyUrl } from '@/lib/constants'
import { clearLocalData } from '@/lib/cleanup'
import { trackEvent, useTelemetryAvailable } from '@/lib/posthog'
import { isTauri } from '@/lib/platform'
import { computeEffectiveProxyEnabled } from '@/lib/proxy-fetch'
import { useHttpClient } from '@/contexts'
import { useMemo, useReducer, useRef, useState, type ChangeEvent } from 'react'

import { LocationSearchCombobox } from '@/components/location-search-combobox'
import { ModificationIndicator } from '@/components/modification-indicator'
import { ThemeToggleGroup } from '@/components/theme-toggle-group'
import { TelemetryRequiredModal, type TelemetryRequiredModalRef } from '@/components/telemetry-required-modal'
import { TelemetryWarningModal, type TelemetryWarningModalRef } from '@/components/telemetry-warning-modal'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { AppVersionSection } from './app-version-section'
import { SyncSetupModal } from '@/components/sync-setup/sync-setup-modal'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { PageHeader } from '@/components/ui/page-header'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SectionCard } from '@/components/ui/section-card'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePostHogClient } from '@/lib/posthog'
import { useActiveLocale } from '@/i18n/use-active-locale'
import { useLanguageSetting } from '@/hooks/use-language-setting'
import { localeForRegion } from '@/i18n/country-language'
import { activeCurrencyCodes, unitDefaultsForRegion, type RegionUnitDefaults } from '@/i18n/region-units'
import { useUnitLabels } from '@/i18n/use-unit-labels'
import { languageLabel, languageOptions } from '@/i18n/language-options'
import type { AppLocale } from '@shared/i18n/locales'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { usePowerSyncStatus } from '@/hooks/use-powersync-status'
import { useSyncEnabledToggle } from '@/hooks/use-sync-enabled-toggle'
import { SettingsPageShell } from '@/components/settings/settings-list'

type PendingImport = { payload: unknown } & ExportSummary

type PreferencesState = {
  isResetting: boolean
  isDeletingAccount: boolean
  isExporting: boolean
  isImporting: boolean
  exportError: string | null
  importError: string | null
  importSuccess: string | null
  pendingImport: PendingImport | null
  resetDialogOpen: boolean
  deleteAccountDialogOpen: boolean
  localizationDialogOpen: boolean
  pendingCountryUnits: RegionUnitDefaults | null
  languageDialogOpen: boolean
  pendingLanguage: AppLocale | null
}

type PreferencesAction =
  | { type: 'SET_IS_RESETTING'; payload: boolean }
  | { type: 'SET_IS_DELETING_ACCOUNT'; payload: boolean }
  | { type: 'SET_IS_EXPORTING'; payload: boolean }
  | { type: 'SET_IS_IMPORTING'; payload: boolean }
  | { type: 'SET_EXPORT_ERROR'; payload: string | null }
  | { type: 'SET_IMPORT_ERROR'; payload: string | null }
  | { type: 'SET_IMPORT_SUCCESS'; payload: string | null }
  | { type: 'SET_PENDING_IMPORT'; payload: PendingImport | null }
  | { type: 'SET_RESET_DIALOG_OPEN'; payload: boolean }
  | { type: 'SET_DELETE_ACCOUNT_DIALOG_OPEN'; payload: boolean }
  | { type: 'CLEAR_IMPORT_FEEDBACK' }
  | { type: 'RESET_STATE' }
  | {
      type: 'SUGGEST_LOCATION_DEFAULTS'
      payload: { countryUnits: RegionUnitDefaults | null; language: AppLocale | null }
    }
  | { type: 'CLOSE_LOCALIZATION_DIALOG' }
  | { type: 'CLOSE_LANGUAGE_DIALOG' }

export const initialPreferencesState: PreferencesState = {
  isResetting: false,
  isDeletingAccount: false,
  isExporting: false,
  isImporting: false,
  exportError: null,
  importError: null,
  importSuccess: null,
  pendingImport: null,
  resetDialogOpen: false,
  deleteAccountDialogOpen: false,
  localizationDialogOpen: false,
  pendingCountryUnits: null,
  languageDialogOpen: false,
  pendingLanguage: null,
}

export const preferencesReducer = (state: PreferencesState, action: PreferencesAction): PreferencesState => {
  switch (action.type) {
    case 'SET_IS_RESETTING':
      return { ...state, isResetting: action.payload }
    case 'SET_IS_DELETING_ACCOUNT':
      return { ...state, isDeletingAccount: action.payload }
    case 'SET_IS_EXPORTING':
      return { ...state, isExporting: action.payload }
    case 'SET_IS_IMPORTING':
      return { ...state, isImporting: action.payload }
    case 'SET_EXPORT_ERROR':
      return { ...state, exportError: action.payload }
    case 'SET_IMPORT_ERROR':
      return { ...state, importError: action.payload }
    case 'SET_IMPORT_SUCCESS':
      return { ...state, importSuccess: action.payload }
    case 'SET_PENDING_IMPORT':
      return { ...state, pendingImport: action.payload }
    case 'SET_RESET_DIALOG_OPEN':
      return { ...state, resetDialogOpen: action.payload }
    case 'SET_DELETE_ACCOUNT_DIALOG_OPEN':
      return { ...state, deleteAccountDialogOpen: action.payload }
    case 'CLEAR_IMPORT_FEEDBACK':
      return { ...state, importError: null, importSuccess: null }
    case 'RESET_STATE':
      return initialPreferencesState
    case 'SUGGEST_LOCATION_DEFAULTS':
      // A location change can suggest both new units and a new language. The
      // two prompts are sequenced rather than stacked: the language ask opens
      // once the units ask is answered.
      return {
        ...state,
        localizationDialogOpen: !!action.payload.countryUnits,
        pendingCountryUnits: action.payload.countryUnits,
        languageDialogOpen: !action.payload.countryUnits && !!action.payload.language,
        pendingLanguage: action.payload.language,
      }
    case 'CLOSE_LOCALIZATION_DIALOG':
      return {
        ...state,
        localizationDialogOpen: false,
        pendingCountryUnits: null,
        languageDialogOpen: !!state.pendingLanguage,
      }
    case 'CLOSE_LANGUAGE_DIALOG':
      // `pendingLanguage` outlives the close so the dialog keeps its copy while
      // it animates out; every suggestion overwrites it, so it can't go stale.
      return { ...state, languageDialogOpen: false }
    default:
      return state
  }
}

/** Every option each unit setting offers. Two-element unions, so they are
 *  literals rather than anything that has to be fetched. */
const distanceUnitOptions = ['metric', 'imperial'] as const
const temperatureUnitOptions = ['c', 'f'] as const
const timeFormatOptions = ['12h', '24h'] as const

export default function PreferencesSettingsPage() {
  const { t } = useLingui()
  const [state, dispatch] = useReducer(preferencesReducer, initialPreferencesState)
  const {
    isResetting,
    isDeletingAccount,
    isExporting,
    isImporting,
    exportError,
    importError,
    importSuccess,
    pendingImport,
    resetDialogOpen,
    deleteAccountDialogOpen,
    localizationDialogOpen,
    pendingCountryUnits,
    languageDialogOpen,
    pendingLanguage,
  } = state
  const authClient = useAuth()
  const db = useDatabase()
  const { data: session } = authClient.useSession()
  const isAuthenticated = !!session?.user
  const isAnonymous = session?.user?.isAnonymous === true
  const isFullUser = isAuthenticated && !isAnonymous
  const { openSignInModal } = useSignInModal()
  const runningInTauri = isTauri()
  const [proxyEnabledStr, setProxyEnabledStr] = useLocalStorage('proxy_enabled', 'false')
  const effectiveProxyEnabled = computeEffectiveProxyEnabled(
    () => runningInTauri,
    () => proxyEnabledStr,
  )
  const proxyDisabled = !runningInTauri || !isAuthenticated
  const proxyTooltipReason = !runningInTauri
    ? t`Proxying is required in the web app to bypass browser CORS restrictions.`
    : t`Sign in to enable cloud proxy.`
  const proxyChecked = proxyDisabled && runningInTauri ? false : effectiveProxyEnabled

  const telemetryRequiredModalRef = useRef<TelemetryRequiredModalRef>(null)
  const telemetryWarningModalRef = useRef<TelemetryWarningModalRef>(null)

  const postHog = usePostHogClient()
  const telemetryAvailable = useTelemetryAvailable()

  const httpClient = useHttpClient()
  const { syncEnabled, syncSetupOpen, setSyncSetupOpen, handleSyncToggle, handleSyncSetupComplete } =
    useSyncEnabledToggle()
  const { connectionStatus } = usePowerSyncStatus()
  const isConnecting = connectionStatus === 'connecting'

  // Use our useSettings hook for all settings
  const {
    preferredName,
    locationName,
    locationLat,
    locationLng,
    locationCountryCode,
    dataCollection,
    experimentalFeatureTasks,
    experimentalFeatureVoice,
    distanceUnit,
    temperatureUnit,
    timeFormat,
    currency,
  } = useSettings({
    preferred_name: '',
    location_name: '',
    location_lat: '',
    location_lng: '',
    location_country_code: '',
    data_collection: false,
    experimental_feature_tasks: false,
    experimental_feature_voice: false,
    // Empty, not a US default. `useUnitDefaults` seeds these asynchronously, so
    // an existing user who skipped the location step can reach this page before
    // the write lands — and a confidently wrong "Imperial (mi)" is worse than a
    // control that is briefly blank.
    distance_unit: '',
    temperature_unit: '',
    time_format: '',
    currency: '',
  })

  const { language, setLanguage, resetLanguage } = useLanguageSetting()

  const hapticsEnabled = useLocalSettingsStore((s) => s.hapticsEnabled)
  const setLocalSetting = useLocalSettingsStore((s) => s.setLocalSetting)

  // Local state for name input (only save on blur to avoid DB writes on every keystroke)
  const [nameInput, setNameInput] = useState('')
  const prevPreferredNameRef = useRef(preferredName.value)

  /** What the UI actually renders in — the setting only pins it once seeded or chosen.
   *  Read from the store rather than re-derived from `language.value`, which is the
   *  schema-defaulted `en` and so cannot tell "unset" from an explicit English choice. */
  const activeLanguage = useActiveLocale()
  // Named so the catalog gets `{activeLanguageLabel}` rather than a positional `{0}`.
  const activeLanguageLabel = languageLabel(activeLanguage)
  const suggestedLanguageLabel = pendingLanguage ? languageLabel(pendingLanguage) : ''

  const unitLabels = useUnitLabels()

  const handleEnableTelemetry = async (featureName?: string | null) => {
    await dataCollection.setValue(true)
    if (featureName === 'experimentalFeatureTasks') {
      await experimentalFeatureTasks.setValue(true)
    }
  }

  const handleDisableTelemetry = async () => {
    await dataCollection.setValue(false)
    await experimentalFeatureTasks.setValue(false)
  }

  // Sync local name input when settings value changes (e.g., async load)
  if (preferredName.value !== prevPreferredNameRef.current) {
    prevPreferredNameRef.current = preferredName.value
    setNameInput(preferredName.value || '')
  }

  const handleDataCollectionToggle = async (value: boolean) => {
    // If turning off telemetry and preview features are enabled, show warning first
    if (!value && experimentalFeatureTasks.value) {
      telemetryWarningModalRef.current?.open()
      return
    }

    await dataCollection.setValue(value)

    if (value) {
      postHog?.opt_in_capturing()
      trackEvent('settings_data_collection_enabled')
    } else {
      trackEvent('settings_data_collection_disabled')
      postHog?.opt_out_capturing()
      // Also disable experimental features
      await experimentalFeatureTasks.setValue(false)
      trackEvent('settings_experimental_feature_tasks_disabled')
    }
  }

  const handleExperimentalFeaturesToggle = async (value: boolean) => {
    // Only require telemetry consent when telemetry is actually wired up.
    // On self-hosted deployments without a PostHog key, this gate would be impossible to satisfy.
    if (value && telemetryAvailable && !dataCollection.value) {
      telemetryRequiredModalRef.current?.open('experimentalFeatureTasks')
      return
    }

    await experimentalFeatureTasks.setValue(value)
    trackEvent(value ? 'settings_experimental_feature_tasks_enabled' : 'settings_experimental_feature_tasks_disabled')
  }

  const handleSelectLocation = async (location: LocationData) => {
    const wasSet = !!locationName.value
    const previousRegion = locationCountryCode.value

    await updateSettings(db, {
      location_name: location.name,
      location_lat: String(location.coordinates.lat),
      location_lng: String(location.coordinates.lng),
      location_country_code: location.countryCode,
    })

    trackEvent(wasSet ? 'settings_location_update' : 'settings_location_set')

    if (!location.countryCode || previousRegion === location.countryCode) {
      return
    }

    // The new region may imply different units and a different UI language.
    // Both are suggestions, never applied without confirmation.
    const suggestedLanguage = localeForRegion(location.countryCode)
    dispatch({
      type: 'SUGGEST_LOCATION_DEFAULTS',
      payload: {
        countryUnits: unitDefaultsForRegion(location.countryCode),
        language: suggestedLanguage && suggestedLanguage !== activeLanguage ? suggestedLanguage : null,
      },
    })
  }

  const handleApplyLocalizationSettings = async () => {
    if (!pendingCountryUnits) {
      return
    }

    // `recomputeHash` establishes the new values as seeded defaults rather than
    // user edits, so a later reset still means "back to auto".
    await updateSettings(
      db,
      {
        distance_unit: pendingCountryUnits.distanceUnit,
        temperature_unit: pendingCountryUnits.temperatureUnit,
        time_format: pendingCountryUnits.timeFormat,
        currency: pendingCountryUnits.currency,
      },
      { recomputeHash: true },
    )

    dispatch({ type: 'CLOSE_LOCALIZATION_DIALOG' })
    trackEvent('settings_localization_update')
  }

  const handleDeclineLocalizationSettings = () => {
    dispatch({ type: 'CLOSE_LOCALIZATION_DIALOG' })
  }

  const handleApplyLanguage = async () => {
    if (!pendingLanguage) {
      return
    }
    // A user edit, unlike the unit defaults above: `useAppLanguage` stops
    // re-seeding from `navigator.languages` once the setting is explicit —
    // otherwise confirming a switch to English would be undone on next boot.
    await setLanguage(pendingLanguage)
    dispatch({ type: 'CLOSE_LANGUAGE_DIALOG' })
    trackEvent('settings_localization_update')
  }

  const handleDeclineLanguage = () => {
    dispatch({ type: 'CLOSE_LANGUAGE_DIALOG' })
  }

  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null)
  const importFileInputRef = useRef<HTMLInputElement>(null)

  const handleImportClick = () => {
    dispatch({ type: 'CLEAR_IMPORT_FEEDBACK' })
    importFileInputRef.current?.click()
  }

  const handleImportFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Reset the input value so re-picking the same file fires `change` again.
    event.target.value = ''
    if (!file) {
      return
    }
    dispatch({ type: 'CLEAR_IMPORT_FEEDBACK' })
    try {
      const payload = await readJsonFile(file)
      const summary = summarizeExportEnvelope(payload, session?.user?.email ?? null)
      if (!summary) {
        dispatch({ type: 'SET_IMPORT_ERROR', payload: t`This file doesn't look like a Thunderbolt export.` })
        return
      }
      dispatch({ type: 'SET_PENDING_IMPORT', payload: { payload, ...summary } })
    } catch (error) {
      console.error('Failed to read import file:', error)
      // `readJsonFile` reports the specific problem (an oversized file names its
      // own size and the limit), so surface its message rather than replacing it
      // with generic copy.
      dispatch({
        type: 'SET_IMPORT_ERROR',
        payload: error instanceof Error ? error.message : t`Could not read the import file.`,
      })
    }
  }

  const handleConfirmImport = async () => {
    if (!pendingImport) {
      return
    }
    const userId = session?.user?.id
    if (!userId) {
      dispatch({ type: 'SET_IMPORT_ERROR', payload: t`You must be signed in to import data.` })
      return
    }
    dispatch({ type: 'SET_IS_IMPORTING', payload: true })
    dispatch({ type: 'SET_IMPORT_ERROR', payload: null })
    try {
      const result = await importUserData(db, pendingImport.payload, { id: userId })
      const total = Object.values(result.tables).reduce((sum, t) => sum + (t?.upserted ?? 0), 0)
      dispatch({
        type: 'SET_IMPORT_SUCCESS',
        payload: plural(total, {
          one: 'Imported # row. The app may take a moment to reflect new chats.',
          other: 'Imported # rows. The app may take a moment to reflect new chats.',
        }),
      })
      trackEvent('settings_data_import')
      dispatch({ type: 'SET_PENDING_IMPORT', payload: null })
    } catch (error) {
      console.error('Failed to import data:', error)
      dispatch({
        type: 'SET_IMPORT_ERROR',
        payload: error instanceof Error ? error.message : t`Failed to import data.`,
      })
    } finally {
      dispatch({ type: 'SET_IS_IMPORTING', payload: false })
    }
  }

  const handleCancelImport = () => {
    if (isImporting) {
      return
    }
    dispatch({ type: 'SET_PENDING_IMPORT', payload: null })
  }

  const handleExportData = async () => {
    const userId = session?.user?.id
    if (!userId) {
      return
    }
    dispatch({ type: 'SET_EXPORT_ERROR', payload: null })
    dispatch({ type: 'SET_IS_EXPORTING', payload: true })
    try {
      const payload = await exportUserData(db, {
        id: userId,
        email: session.user.email ?? null,
      })
      downloadJson(exportFilenameFor(new Date()), payload)
      trackEvent('settings_data_export')
    } catch (error) {
      console.error('Failed to export data:', error)
      dispatch({
        type: 'SET_EXPORT_ERROR',
        payload: error instanceof Error ? error.message : t`Failed to export data.`,
      })
    } finally {
      dispatch({ type: 'SET_IS_EXPORTING', payload: false })
    }
  }

  const handleResetDatabase = async () => {
    dispatch({ type: 'SET_IS_RESETTING', payload: true })
    try {
      await clearLocalData()
      trackEvent('settings_database_reset')
      window.location.reload()
    } catch (error) {
      console.error('Failed to reset database:', error)
      dispatch({ type: 'SET_IS_RESETTING', payload: false })
    }
  }

  const handleDeleteAccount = async () => {
    setDeleteAccountError(null)
    dispatch({ type: 'SET_IS_DELETING_ACCOUNT', payload: true })

    try {
      await httpClient.delete('account')
      await clearLocalData()
      window.location.reload()
    } catch (error) {
      console.error('Failed to delete account:', error)
      setDeleteAccountError(error instanceof Error ? error.message : t`Failed to delete account.`)
    } finally {
      dispatch({ type: 'SET_IS_DELETING_ACCOUNT', payload: false })
    }
  }

  /**
   * The country code resets with the rest of the location, or a cleared
   * location would leave a ghost region behind — `regionForUnitDefaults` reads
   * it first, so resetting a unit afterwards would re-seed from the country the
   * user just removed instead of falling through to the browser.
   */
  const handleResetLocation = async () => {
    await Promise.all([locationName.reset(), locationLat.reset(), locationLng.reset(), locationCountryCode.reset()])
  }

  /**
   * Back to auto, exactly like the language row: clearing the value re-arms
   * `useUnitDefaults`, which re-seeds from the stored location region, then the
   * browser, then the app locale. The previous version only ever consulted the
   * location, so a user with no location got nothing back.
   */
  const handleResetLocalizationSetting = async (settingType: 'distance' | 'temperature' | 'time' | 'currency') => {
    const hooks = {
      distance: distanceUnit,
      temperature: temperatureUnit,
      time: timeFormat,
      currency: currency,
    }
    await hooks[settingType].reset()
    trackEvent('settings_localization_reset')
  }

  const currencyItems = useMemo(
    () =>
      activeCurrencyCodes.map((code) => ({
        id: code,
        label: unitLabels.currency(code),
        // Searchable by code as well as by name, since plenty of people know
        // their currency as "SEK" rather than by its spelled-out name.
        filterValue: `${code} ${unitLabels.currency(code)}`,
      })),
    [unitLabels],
  )

  /**
   * Rendered from the stored code rather than looked up in `currencyItems`, so
   * a currency that has dropped off the region table still displays. Bulgaria
   * moved to the euro, but anyone who picked BGN before still holds it.
   */
  const currencyDisplayValue = currency.value ? unitLabels.currency(currency.value) : ''

  // Bound so the catalog placeholders are named rather than positional.
  const importSourceEmail = pendingImport?.sourceEmail ?? ''
  const importExportedAt = pendingImport?.exportedAtLabel ?? ''

  /**
   * One whole sentence per provenance combination rather than appending optional
   * clauses: a translator needs to place "exported by X" and "on Y" in their own
   * grammar, and each combination needs its own plural forms for the row count.
   * ICU's `#` formats the count for the active locale, so it doesn't go through
   * `useFormatters` on the way in.
   */
  const importSummary = (rows: number): string => {
    if (importSourceEmail && importExportedAt) {
      return plural(rows, {
        one: `This file contains # row exported by ${importSourceEmail} on ${importExportedAt}.`,
        other: `This file contains # rows exported by ${importSourceEmail} on ${importExportedAt}.`,
      })
    }
    if (importSourceEmail) {
      return plural(rows, {
        one: `This file contains # row exported by ${importSourceEmail}.`,
        other: `This file contains # rows exported by ${importSourceEmail}.`,
      })
    }
    if (importExportedAt) {
      return plural(rows, {
        one: `This file contains # row on ${importExportedAt}.`,
        other: `This file contains # rows on ${importExportedAt}.`,
      })
    }
    return plural(rows, {
      one: 'This file contains # row.',
      other: 'This file contains # rows.',
    })
  }

  return (
    <SettingsPageShell className="gap-6 md:pb-12">
      <PageHeader title={t`Preferences`} />

      <SectionCard title={t`User Experience`}>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">
              <Trans>Theme</Trans>
            </label>
            <ThemeToggleGroup />
          </div>

          <div className="h-px bg-border -mx-6" />

          <div className="flex-row flex items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={hapticsEnabled !== initialLocalSettings.hapticsEnabled}
                onReset={() => setLocalSetting('hapticsEnabled', initialLocalSettings.hapticsEnabled)}
              >
                <Trans>Haptic Feedback</Trans>
              </ModificationIndicator>
              <p className="text-sm text-muted-foreground">
                <Trans>Vibrate on tap</Trans>
              </p>
            </div>
            <Switch
              checked={hapticsEnabled}
              onCheckedChange={(value) => setLocalSetting('hapticsEnabled', value)}
              aria-label={t`Haptic Feedback`}
            />
          </div>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title={t`Personalization`}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <ModificationIndicator
              as="label"
              className="text-sm font-medium"
              hasModifications={preferredName.isModified}
              onReset={async () => {
                await preferredName.reset()
                setNameInput('')
              }}
            >
              <Trans>Preferred Name</Trans>
            </ModificationIndicator>
            <Input
              placeholder={t`Your name`}
              className="rounded-lg"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={async (e) => {
                const value = e.target.value
                const wasSet = !!preferredName.value
                await preferredName.setValue(value || null)
                if (value.trim()) {
                  trackEvent(wasSet ? 'settings_name_update' : 'settings_name_set')
                } else {
                  trackEvent('settings_name_clear')
                }
              }}
            />
            <p className="text-sm text-muted-foreground">
              <Trans>How Thunderbolt salutes you</Trans>
            </p>
          </div>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title={t`Localization`}>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <ModificationIndicator
              as="label"
              id="localization-location-label"
              className="text-sm font-medium"
              hasModifications={
                locationName.isModified ||
                locationLat.isModified ||
                locationLng.isModified ||
                locationCountryCode.isModified
              }
              onReset={handleResetLocation}
            >
              <Trans>Location</Trans>
            </ModificationIndicator>
            <LocationSearchCombobox
              value={locationName.value}
              onSelect={handleSelectLocation}
              id="localization-location-trigger"
              aria-labelledby="localization-location-label localization-location-trigger"
            />
            <p className="text-sm text-muted-foreground">
              <Trans>Enables location-based responses</Trans>
            </p>
          </div>

          <div className="h-px bg-border -mx-6" />

          {/* Language */}
          <div className="flex flex-row items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={language.isModified}
                onReset={async () => {
                  await resetLanguage()
                  trackEvent('settings_localization_reset')
                }}
              >
                <Trans>Language</Trans>
              </ModificationIndicator>
            </div>
            <Select
              value={activeLanguage}
              onValueChange={async (v) => {
                await setLanguage(v)
                trackEvent('settings_localization_update')
              }}
            >
              <SelectTrigger className="w-auto rounded-lg" aria-label={t`Language`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {languageOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Distance */}
          <div className="flex flex-row items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={distanceUnit.isModified}
                onReset={() => handleResetLocalizationSetting('distance')}
              >
                <Trans>Distance</Trans>
              </ModificationIndicator>
            </div>
            <Select
              value={distanceUnit.value}
              onValueChange={async (v) => {
                await distanceUnit.setValue(v)
                trackEvent('settings_localization_update')
              }}
            >
              <SelectTrigger className="w-auto rounded-lg" aria-label={t`Distance unit`} data-testid="distance-unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {distanceUnitOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {unitLabels.distance(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Temperature */}
          <div className="flex flex-row items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={temperatureUnit.isModified}
                onReset={() => handleResetLocalizationSetting('temperature')}
              >
                <Trans>Temperature</Trans>
              </ModificationIndicator>
            </div>
            <Select
              value={temperatureUnit.value}
              onValueChange={async (v) => {
                await temperatureUnit.setValue(v)
                trackEvent('settings_localization_update')
              }}
            >
              <SelectTrigger
                className="w-auto rounded-lg"
                aria-label={t`Temperature unit`}
                data-testid="temperature-unit"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {temperatureUnitOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {unitLabels.temperature(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Time Format */}
          <div className="flex flex-row items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                className="text-sm font-medium"
                hasModifications={timeFormat.isModified}
                onReset={() => handleResetLocalizationSetting('time')}
              >
                <Trans>Time Format</Trans>
              </ModificationIndicator>
            </div>
            <Select
              value={timeFormat.value}
              onValueChange={async (v) => {
                await timeFormat.setValue(v)
                trackEvent('settings_localization_update')
              }}
            >
              <SelectTrigger className="w-auto rounded-lg" aria-label={t`Time format`} data-testid="time-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {timeFormatOptions.map((option) => (
                  <SelectItem key={option} value={option}>
                    {unitLabels.timeFormat(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Currency - searchable, uses Combobox */}
          <div className="flex flex-row items-center gap-4">
            <div className="flex-1">
              <ModificationIndicator
                as="label"
                id="localization-currency-label"
                className="text-sm font-medium"
                hasModifications={currency.isModified}
                onReset={() => handleResetLocalizationSetting('currency')}
              >
                <Trans>Currency</Trans>
              </ModificationIndicator>
            </div>
            <Combobox
              items={currencyItems}
              value={currency.value}
              onValueChange={async (v) => {
                await currency.setValue(v)
                trackEvent('settings_localization_update')
              }}
              displayValue={currencyDisplayValue || undefined}
              id="localization-currency-trigger"
              data-testid="currency"
              aria-labelledby="localization-currency-label localization-currency-trigger"
              searchPlaceholder={t`Search currencies…`}
              className="w-auto"
              contentClassName="w-[300px]"
              align="end"
            />
          </div>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title={t`Help Thunderbolt Improve`}>
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <label className="text-sm font-medium">
              <Trans>Preview Features</Trans>
            </label>

            <div className="flex-row flex items-center gap-4">
              <div className="flex-1">
                <ModificationIndicator
                  as="label"
                  className="text-sm font-medium"
                  hasModifications={experimentalFeatureTasks.isModified}
                  onReset={experimentalFeatureTasks.reset}
                >
                  <Trans>Tasks</Trans>
                </ModificationIndicator>
              </div>
              <Switch
                checked={experimentalFeatureTasks.value}
                onCheckedChange={handleExperimentalFeaturesToggle}
                aria-label={t`Tasks`}
              />
            </div>

            <div className="flex-row flex items-center gap-4">
              <div className="flex-1">
                <ModificationIndicator
                  as="label"
                  className="text-sm font-medium"
                  hasModifications={experimentalFeatureVoice.isModified}
                  onReset={experimentalFeatureVoice.reset}
                >
                  <Trans>Custom voice provider</Trans>
                </ModificationIndicator>
              </div>
              <Switch
                checked={experimentalFeatureVoice.value}
                onCheckedChange={(value) => experimentalFeatureVoice.setValue(value)}
                aria-label={t`Custom voice provider`}
              />
            </div>
          </div>

          <div className="h-px bg-border -mx-6" />

          <div className="flex-row flex items-center gap-4">
            <div className="flex-1">
              <div className="mb-2">
                <ModificationIndicator
                  as="label"
                  className="text-sm font-medium"
                  hasModifications={dataCollection.isModified}
                  onReset={dataCollection.reset}
                >
                  <Trans>Anonymous Usage Data</Trans>
                </ModificationIndicator>
              </div>
              {telemetryAvailable ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>
                    Help us improve the app by sending anonymous usage info such as crashes, performance, and usage.
                    Read more about our{' '}
                    <a
                      className="text-primary underline-offset-4 hover:underline"
                      href={privacyPolicyUrl}
                      target="_blank"
                    >
                      privacy policy
                    </a>
                    .
                  </Trans>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  <Trans>Telemetry isn't configured for this organization, so no usage data is being collected.</Trans>
                </p>
              )}
            </div>
            <Switch
              checked={telemetryAvailable && dataCollection.value}
              onCheckedChange={handleDataCollectionToggle}
              disabled={!telemetryAvailable}
              aria-label={t`Anonymous Usage Data`}
            />
          </div>
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title={t`Network`}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">
              <Trans>Use Cloud Proxy</Trans>
            </label>
            <p className="text-sm text-muted-foreground">
              <Trans>When enabled, requests are routed through Thunderbolt's cloud proxy.</Trans>
            </p>
          </div>
          {proxyDisabled ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} aria-label={proxyTooltipReason}>
                  <Switch
                    checked={proxyChecked}
                    disabled
                    aria-label={t`Use Cloud Proxy`}
                    className="pointer-events-none"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{proxyTooltipReason}</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Switch
              checked={proxyChecked}
              onCheckedChange={(checked) => setProxyEnabledStr(checked ? 'true' : 'false')}
              aria-label={t`Use Cloud Proxy`}
            />
          )}
        </div>
      </SectionCard>

      <div className="h-6" />

      <SectionCard title={t`Data`}>
        <div className="flex flex-col gap-6">
          {isFullUser ? (
            <div className="flex-row flex items-center gap-4 justify-between">
              <div>
                <label className="text-sm font-medium">
                  <Trans>Sync This Device With Cloud</Trans>
                </label>
              </div>
              <Switch
                checked={syncEnabled}
                onCheckedChange={handleSyncToggle}
                disabled={isConnecting}
                aria-label={t`Sync This Device With Cloud`}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">
                <Trans>Sync This Device With Cloud</Trans>
              </label>
              <Button onClick={openSignInModal}>
                <Trans>Sign In</Trans>
              </Button>
            </div>
          )}

          {isAuthenticated && (
            <>
              <div className="h-px bg-border -mx-6" />

              <div className="flex flex-col gap-2">
                <label htmlFor="export-data-button" className="text-sm font-medium">
                  <Trans>Export Your Data</Trans>
                </label>
                <p id="export-data-description" className="text-sm text-muted-foreground">
                  <Trans>Export all of your data as JSON.</Trans>
                </p>
                {exportError && (
                  <p id="export-data-error" className="text-sm text-destructive" role="alert">
                    {exportError}
                  </p>
                )}
                <Button
                  id="export-data-button"
                  variant="secondary"
                  disabled={isExporting}
                  aria-busy={isExporting}
                  aria-describedby={exportError ? 'export-data-error' : 'export-data-description'}
                  onClick={handleExportData}
                >
                  {isExporting ? t`Exporting…` : t`Export My Data`}
                </Button>
              </div>

              <div className="h-px bg-border -mx-6" />

              <div className="flex flex-col gap-2">
                <label htmlFor="import-data-button" className="text-sm font-medium">
                  <Trans>Import Your Data</Trans>
                </label>
                <p id="import-data-description" className="text-sm text-muted-foreground">
                  <Trans>Import your data from previously exported JSON.</Trans>
                </p>
                {importError && (
                  <p id="import-data-error" className="text-sm text-destructive" role="alert">
                    {importError}
                  </p>
                )}
                {importSuccess && (
                  <p id="import-data-success" className="text-sm text-muted-foreground" role="status">
                    {importSuccess}
                  </p>
                )}
                <input
                  ref={importFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleImportFileSelected}
                />
                <Button
                  id="import-data-button"
                  variant="secondary"
                  disabled={isImporting}
                  aria-busy={isImporting}
                  aria-describedby={
                    importError
                      ? 'import-data-error'
                      : importSuccess
                        ? 'import-data-success'
                        : 'import-data-description'
                  }
                  onClick={handleImportClick}
                >
                  {isImporting ? t`Importing…` : t`Import Data`}
                </Button>
              </div>
            </>
          )}

          {isAnonymous && (
            <>
              <div className="h-px bg-border -mx-6" />

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">
                  <Trans>Delete All Local Data</Trans>
                </label>
                <Button
                  variant="secondary"
                  disabled={isResetting}
                  onClick={() => dispatch({ type: 'SET_RESET_DIALOG_OPEN', payload: true })}
                >
                  {isResetting ? t`Resetting…` : t`Reset Database`}
                </Button>
                <ConfirmActionDialog
                  open={resetDialogOpen}
                  title={t`Reset Local Database?`}
                  description={t`This will permanently delete all of your local data including settings, chat history, and cached information. This action cannot be undone.`}
                  confirmLabel={t`Reset Database`}
                  isPending={isResetting}
                  onConfirm={() => {
                    dispatch({ type: 'SET_RESET_DIALOG_OPEN', payload: false })
                    void handleResetDatabase()
                  }}
                  onCancel={() => dispatch({ type: 'SET_RESET_DIALOG_OPEN', payload: false })}
                />
              </div>
            </>
          )}

          {isFullUser && (
            <>
              <div className="h-px bg-border -mx-6" />

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">
                  <Trans>Delete Your Account</Trans>
                </label>
                <p className="text-sm text-muted-foreground">
                  <Trans>Permanently delete your account and all data on our servers and this device.</Trans>
                </p>
                {deleteAccountError && (
                  <p className="text-sm text-destructive" role="alert">
                    {deleteAccountError}
                  </p>
                )}
                {/* Secondary on the page; the red danger styling lives on the
                    confirm button inside the dialog. */}
                <Button
                  variant="secondary"
                  disabled={isDeletingAccount}
                  onClick={() => dispatch({ type: 'SET_DELETE_ACCOUNT_DIALOG_OPEN', payload: true })}
                >
                  {isDeletingAccount ? t`Deleting…` : t`Delete My Account`}
                </Button>
                <ConfirmActionDialog
                  open={deleteAccountDialogOpen}
                  title={t`Delete your account?`}
                  description={t`This will permanently delete your account and all of your data on our servers and on this device, including settings, chat history, and cached information. This action cannot be undone.`}
                  confirmLabel={t`Delete account`}
                  isPending={isDeletingAccount}
                  onConfirm={() => {
                    dispatch({ type: 'SET_DELETE_ACCOUNT_DIALOG_OPEN', payload: false })
                    void handleDeleteAccount()
                  }}
                  onCancel={() => dispatch({ type: 'SET_DELETE_ACCOUNT_DIALOG_OPEN', payload: false })}
                />
              </div>
            </>
          )}
        </div>
      </SectionCard>

      <div className="h-6" />

      <AppVersionSection />

      <SyncSetupModal open={syncSetupOpen} onOpenChange={setSyncSetupOpen} onComplete={handleSyncSetupComplete} />

      <TelemetryRequiredModal ref={telemetryRequiredModalRef} onEnableTelemetry={handleEnableTelemetry} />

      <TelemetryWarningModal ref={telemetryWarningModalRef} onDisableTelemetry={handleDisableTelemetry} />

      <AlertDialog open={pendingImport !== null} onOpenChange={(open) => !open && handleCancelImport()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Import this backup?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingImport && (
                <>
                  {importSummary(pendingImport.totalRows)}{' '}
                  <Trans>
                    Rows that share an ID with existing data will be overwritten with the file's version and synced to
                    your other devices. This can't be undone.
                  </Trans>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingImport?.accountMismatch && (
            <p className="text-sm text-destructive font-medium" role="alert">
              <Trans>
                ⚠ This export was made by a different account ({importSourceEmail}). Importing it here will mix that
                data into your account. Confirm only if you intend to.
              </Trans>
            </p>
          )}
          {importError && (
            <p className="text-sm text-destructive" role="alert">
              {importError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isImporting}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmImport}
              disabled={isImporting}
              aria-busy={isImporting}
              variant="destructive"
            >
              {isImporting ? t`Importing…` : t`Import`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={localizationDialogOpen} onOpenChange={(open) => !open && handleDeclineLocalizationSettings()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Update Defaults?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Would you like to update your units based on the new location?</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Keep Current Units</Trans>
            </AlertDialogCancel>
            <AlertDialogAction autoFocus onClick={handleApplyLocalizationSettings}>
              <Trans>Update Units</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {pendingLanguage && (
        <AlertDialog open={languageDialogOpen} onOpenChange={(open) => !open && handleDeclineLanguage()}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Change Language?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>Would you like to change the language to {suggestedLanguageLabel}?</Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <Trans>Keep {activeLanguageLabel}</Trans>
              </AlertDialogCancel>
              <AlertDialogAction autoFocus onClick={handleApplyLanguage}>
                <Trans>Switch to {suggestedLanguageLabel}</Trans>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </SettingsPageShell>
  )
}
