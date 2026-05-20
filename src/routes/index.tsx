import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useEffect } from 'react'
import { posthog } from './__root'
import { AuthScreen } from '../components/AuthScreen'
import { OnboardingScreen } from '../components/OnboardingScreen'
import { PlaceViewScreen } from '../components/PlaceViewScreen'
import { ScanJoinScreen } from '../components/ScanJoinScreen'
import {
  connectFromScan,
  endCurrentConnection,
  getAppState,
  getNearbyPlacePreview,
  leaveCurrentPlace,
  joinPlaceAndConnectFromScan,
  pingFindableUser,
  previewScanJoin,
  resolveScanToken,
  saveFinderProfile,
  saveUserProfile,
  setReadyState,
  searchNearbyPlacesForLocation,
} from '../lib/server/app-state'

const loadAppState = createServerFn({ method: 'GET' }).handler(async () => {
  return getAppState()
})

const searchNearbyPlaces = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: { latitude: number; longitude: number }) => input,
  )
  .handler(async ({ data }) => {
    return searchNearbyPlacesForLocation(data)
  })

const loadNearbyPlacePreview = createServerFn({ method: 'POST' })
  .inputValidator((input: { placeId: string }) => input)
  .handler(async ({ data }) => {
    return getNearbyPlacePreview(data)
  })

const upsertUserProfile = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: {
      moodEmoji: string
      intentText: string
      currentPlaceId: string
    }) => input,
  )
  .handler(async ({ data }) => {
    return saveUserProfile(data)
  })

const updateReadyState = createServerFn({ method: 'POST' })
  .inputValidator((input: { ready: boolean }) => input)
  .handler(async ({ data }) => {
    return setReadyState(data)
  })

const updateFinderProfile = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: { isFindable: boolean; locationHint: string | null }) => input,
  )
  .handler(async ({ data }) => {
    return saveFinderProfile(data)
  })

const clearCurrentPlace = createServerFn({ method: 'POST' }).handler(async () => {
  return leaveCurrentPlace()
})

const pingParticipant = createServerFn({ method: 'POST' })
  .inputValidator((input: { userId: string }) => input)
  .handler(async ({ data }) => {
    return pingFindableUser(data)
  })

const loadScanPreview = createServerFn({ method: 'POST' })
  .inputValidator((input: { token: string }) => input)
  .handler(async ({ data }) => {
    return resolveScanToken(data)
  })

const connectScannedQr = createServerFn({ method: 'POST' })
  .inputValidator((input: { token: string }) => input)
  .handler(async ({ data }) => {
    return connectFromScan(data)
  })

const endConversation = createServerFn({ method: 'POST' }).handler(async () => {
  return endCurrentConnection()
})

const loadScanJoinPreview = createServerFn({ method: 'POST' })
  .inputValidator((input: { token: string }) => input)
  .handler(async ({ data }) => {
    return previewScanJoin(data)
  })

const joinScannedPlace = createServerFn({ method: 'POST' })
  .inputValidator((input: { token: string }) => input)
  .handler(async ({ data }) => {
    return joinPlaceAndConnectFromScan(data)
  })

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    scan: typeof search.scan === 'string' ? search.scan : undefined,
  }),
  loader: async () => loadAppState(),
  component: App,
})

function App() {
  const {
    session,
    profile,
    currentPlace,
    qrHandoff,
    activeConnection,
  } = Route.useLoaderData()
  const { scan } = Route.useSearch()
  const router = useRouter()

  // Identify the user in PostHog once session is available
  useEffect(() => {
    if (session?.user?.id) {
      posthog.identify(session.user.id, {
        username: session.user.username,
        name: session.user.name,
      })
    }
  }, [session?.user?.id])

  const refreshSession = async () => {
    await router.invalidate()
  }

  const clearScanToken = async () => {
    await router.navigate({
      to: '/',
      search: {
        scan: undefined,
      },
    })
  }

  // Analytics-wrapped handlers
  const trackedSetReady: typeof updateReadyState = async (opts) => {
    const result = await updateReadyState(opts)
    posthog.capture(opts.data.ready ? 'user_set_ready' : 'user_set_not_ready', {
      place_id: profile?.currentPlaceId,
    })
    return result
  }

  const trackedLeavePlace: typeof clearCurrentPlace = async (opts) => {
    posthog.capture('user_left_place', { place_id: profile?.currentPlaceId })
    return clearCurrentPlace(opts)
  }

  const trackedConnectScan: typeof connectScannedQr = async (opts) => {
    const result = await connectScannedQr(opts)
    if (result.success) posthog.capture('qr_connection_made', { place_id: profile?.currentPlaceId })
    return result
  }

  const trackedJoinScannedPlace: typeof joinScannedPlace = async (opts) => {
    const result = await joinScannedPlace(opts)
    posthog.capture('scan_join_place')
    return result
  }

  const trackedSaveProfile: typeof upsertUserProfile = async (opts) => {
    const result = await upsertUserProfile(opts)
    posthog.capture('checked_in', { place_id: opts.data.currentPlaceId })
    return result
  }

  if (!session) {
    return <AuthScreen refreshSession={refreshSession} />
  }

  if (scan && !profile?.currentPlaceId) {
    return (
      <ScanJoinScreen
        session={session}
        scanToken={scan}
        refreshSession={refreshSession}
        clearScanToken={clearScanToken}
        loadPreview={loadScanJoinPreview}
        joinAndConnect={trackedJoinScannedPlace}
      />
    )
  }

  if (profile && currentPlace && qrHandoff) {
    return (
      <PlaceViewScreen
        session={session}
        profile={profile}
        currentPlace={currentPlace}
        qrHandoff={qrHandoff}
        activeConnection={activeConnection}
        initialScanToken={scan ?? null}
        refreshSession={refreshSession}
        clearScanToken={clearScanToken}
        setReady={trackedSetReady}
        saveFinderProfile={updateFinderProfile}
        leavePlace={trackedLeavePlace}
        pingParticipant={pingParticipant}
        loadScanPreview={loadScanPreview}
        connectScan={trackedConnectScan}
        endConversation={endConversation}
      />
    )
  }

  return (
    <OnboardingScreen
      session={session}
      profile={profile}
      refreshSession={refreshSession}
      searchNearbyPlaces={searchNearbyPlaces}
      loadNearbyPlacePreview={loadNearbyPlacePreview}
      saveProfile={trackedSaveProfile}
    />
  )
}
