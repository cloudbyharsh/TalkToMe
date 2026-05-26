import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useEffect } from 'react'
import { posthog } from './__root'
import { AuthScreen } from '../components/AuthScreen'
import { OnboardingScreen } from '../components/OnboardingScreen'
import { PlaceViewScreen } from '../components/PlaceViewScreen'
import {
  addMessageToRequest,
  endCurrentConnection,
  getAppState,
  getNearbyPlacePreview,
  leaveCurrentPlace,
  pingFindableUser,
  respondToConnectRequest,
  saveFinderProfile,
  saveUserProfile,
  searchNearbyPlacesForLocation,
  sendConnectRequest,
  setReadyState,
} from '../lib/server/app-state'

const loadAppState = createServerFn({ method: 'GET' }).handler(async () => {
  return getAppState()
})

const searchNearbyPlaces = createServerFn({ method: 'POST' })
  .inputValidator((input: { latitude: number; longitude: number }) => input)
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
    (input: { moodEmoji: string; intentText: string; currentPlaceId: string }) => input,
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
  .inputValidator((input: { isFindable: boolean; locationHint: string | null }) => input)
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

const submitConnectRequest = createServerFn({ method: 'POST' })
  .inputValidator((input: { recipientUserId: string; introMessage: string }) => input)
  .handler(async ({ data }) => {
    return sendConnectRequest(data)
  })

const submitRequestMessage = createServerFn({ method: 'POST' })
  .inputValidator((input: { requestId: string; body: string }) => input)
  .handler(async ({ data }) => {
    return addMessageToRequest(data)
  })

const replyToConnectRequest = createServerFn({ method: 'POST' })
  .inputValidator((input: { requestId: string; accept: boolean }) => input)
  .handler(async ({ data }) => {
    return respondToConnectRequest(data)
  })

const endConversation = createServerFn({ method: 'POST' }).handler(async () => {
  return endCurrentConnection()
})

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({}),
  loader: async () => loadAppState(),
  component: App,
})

function App() {
  const { session, profile, currentPlace, pendingIncomingRequests, activeConnection } =
    Route.useLoaderData()
  const router = useRouter()

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

  const trackedSendRequest: typeof submitConnectRequest = async (opts) => {
    const result = await submitConnectRequest(opts)
    posthog.capture('connect_request_sent', { place_id: profile?.currentPlaceId })
    return result
  }

  const trackedRespondToRequest: typeof replyToConnectRequest = async (opts) => {
    const result = await replyToConnectRequest(opts)
    posthog.capture(opts.data.accept ? 'connect_request_accepted' : 'connect_request_rejected', {
      place_id: profile?.currentPlaceId,
    })
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

  if (profile && currentPlace) {
    return (
      <PlaceViewScreen
        session={session}
        profile={profile}
        currentPlace={currentPlace}
        activeConnection={activeConnection}
        pendingIncomingRequests={pendingIncomingRequests}
        refreshSession={refreshSession}
        setReady={trackedSetReady}
        saveFinderProfile={updateFinderProfile}
        leavePlace={trackedLeavePlace}
        pingParticipant={pingParticipant}
        sendConnectRequest={trackedSendRequest}
        addRequestMessage={submitRequestMessage}
        respondToRequest={trackedRespondToRequest}
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
