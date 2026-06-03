import { lazy, Suspense, useEffect, useState } from 'react'
import {
  ArrowLeft,
  MapPin,
  Users,
} from 'lucide-react'
import { authClient } from '../lib/auth-client'
import type {
  AppSession,
  NearbyPlace,
  NearbyPlacePreviewState,
  UserProfileState,
} from '../lib/app-types'

// Lazy-loaded so Leaflet (browser-only) never enters the SSR/Workers bundle
const NearbyPlacesMap = lazy(() =>
  import('./NearbyPlacesMap').then((m) => ({ default: m.NearbyPlacesMap })),
)

type AuthResult = {
  error?: {
    message?: string | null
  } | null
}

type OnboardingClientLike = {
  signOut: () => Promise<AuthResult>
}

type LocationStatus =
  | 'idle'
  | 'requesting'
  | 'granted'
  | 'denied'
  | 'unsupported'

const MOOD_OPTIONS = [
  { emoji: '👋', label: 'Friendly' },
  { emoji: '☕', label: 'Chill' },
  { emoji: '💡', label: 'Curious' },
  { emoji: '🧘', label: 'Calm' },
  { emoji: '🚀', label: 'Energised' },
  { emoji: '❤️', label: 'Warm' },
]

const TAG_OPTIONS = [
  'Tech', 'Design', 'Coffee', 'Startups', 'Books',
  'Music', 'Travel', 'Fitness', 'Art', 'Food',
  'Photography', 'Gaming', 'Science', 'Film',
]

export function OnboardingScreen({
  session,
  profile,
  refreshSession,
  searchNearbyPlaces,
  loadNearbyPlacePreview,
  saveProfile,
  client = authClient,
}: {
  session: AppSession
  profile: UserProfileState | null
  refreshSession: () => Promise<void>
  searchNearbyPlaces: (input: {
    data: {
      latitude: number
      longitude: number
    }
  }) => Promise<NearbyPlace[]>
  loadNearbyPlacePreview: (input: {
    data: {
      placeId: string
    }
  }) => Promise<NearbyPlacePreviewState>
  saveProfile: (input: {
    data: {
      moodEmoji: string
      intentText: string
      currentPlaceId: string
    }
  }) => Promise<UserProfileState>
  client?: OnboardingClientLike
}) {
  const [pendingAction, setPendingAction] = useState<'sign-out' | 'save' | null>(
    null,
  )
  const [locationStatus, setLocationStatus] = useState<LocationStatus>('idle')
  const [locationError, setLocationError] = useState<string | null>(null)
  const [locationCoords, setLocationCoords] = useState<{
    latitude: number
    longitude: number
  } | null>(null)
  const [places, setPlaces] = useState<NearbyPlace[]>([])
  const [placesError, setPlacesError] = useState<string | null>(null)
  const [placesLoading, setPlacesLoading] = useState(false)
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null)
  const [placePreview, setPlacePreview] = useState<NearbyPlacePreviewState | null>(
    null,
  )
  const [placePreviewLoading, setPlacePreviewLoading] = useState(false)
  const [placePreviewError, setPlacePreviewError] = useState<string | null>(null)
  const [moodEmoji, setMoodEmoji] = useState(profile?.moodEmoji ?? '👋')
  const [intentText, setIntentText] = useState(profile?.intentText ?? '')
  const [selectedTags, setSelectedTags] = useState<string[]>(profile?.tags ?? [])
  const [saveError, setSaveError] = useState<string | null>(null)

  const username =
    session.user.displayUsername || session.user.username || session.user.name
  const selectedPlace =
    places.find((place) => place.placeId === selectedPlaceId) ?? null
  const totalReadyCount = places.reduce(
    (sum, place) => sum + place.readyCount,
    0,
  )
  const busiestPlace =
    places.length > 0
      ? [...places].sort((left, right) => right.readyCount - left.readyCount)[0]
      : null
  const isChoosingPlace = locationStatus === 'granted' && !selectedPlace

  const handleSignOut = async () => {
    setPendingAction('sign-out')
    setSaveError(null)

    const result = await client.signOut()

    if (result.error) {
      setSaveError(result.error.message || 'Unable to sign out right now.')
      setPendingAction(null)
      return
    }

    await refreshSession()
    setPendingAction(null)
  }

  const loadNearbyPlaces = async (coords: {
    latitude: number
    longitude: number
  }) => {
    setPlacesLoading(true)
    setPlacesError(null)
    setLocationCoords(coords)

    try {
      const result = await searchNearbyPlaces({
        data: coords,
      })

      setPlaces(result)
      setSelectedPlaceId(
        (currentSelection) =>
          currentSelection &&
          result.some((place) => place.placeId === currentSelection)
            ? currentSelection
            : null,
      )
    } catch (error) {
      setPlacesError(
        error instanceof Error
          ? error.message
          : 'Unable to load nearby places right now.',
      )
    } finally {
      setPlacesLoading(false)
    }
  }

  // iOS Safari has two layers of location permission (system-level Location Services
  // AND per-site Safari permission). navigator.permissions.query is also unreliable
  // on iOS, so we detect the platform and handle it separately.
  const isIOS =
    typeof navigator !== 'undefined' &&
    /iPad|iPhone|iPod/.test(navigator.userAgent)

  const handleEnableLocation = () => {
    if (!navigator.geolocation) {
      setLocationStatus('unsupported')
      setLocationError('This browser cannot share location yet.')
      return
    }

    setLocationStatus('requesting')
    setLocationError(null)

    const onSuccess = (position: GeolocationPosition) => {
      setLocationStatus('granted')
      void loadNearbyPlaces({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      })
    }

    const onError = (error: GeolocationPositionError) => {
      setLocationStatus('denied')
      if (error.code === error.PERMISSION_DENIED) {
        if (isIOS) {
          setLocationError(
            'Location access was blocked. On iPhone: go to Settings → Privacy & Security → Location Services → Safari → set to "While Using the App". Then come back and try again.',
          )
        } else {
          setLocationError(
            'Location access is required. Please allow it in your browser settings and try again.',
          )
        }
      } else if (error.code === error.TIMEOUT) {
        setLocationError(
          'Location took too long. Make sure location services are on and try again.',
        )
      } else {
        setLocationError(
          'Unable to read your location. Check that location services are enabled on your device and try again.',
        )
      }
    }

    // Use a single getCurrentPosition call with settings tuned for mobile.
    // enableHighAccuracy: false uses WiFi/cell positioning — faster, more
    // reliable indoors, and avoids the iOS GPS cold-start delay. A 15s timeout
    // accommodates slow responses without being as aggressive as the previous 8s.
    // The nested dual-call pattern (calling getCurrentPosition a second time
    // inside the error callback) is unreliable on iOS Safari and is avoided here.
    navigator.geolocation.getCurrentPosition(onSuccess, onError, {
      enableHighAccuracy: false,
      timeout: 15000,
      maximumAge: 60000,
    })
  }

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return
    }

    // navigator.permissions.query for geolocation is unreliable on iOS Safari —
    // it may return stale state or not fire the change event correctly.
    // On iOS we skip the auto-trigger entirely and let the user tap the button,
    // which is also required on iOS because geolocation must be user-gesture-initiated.
    if (isIOS || !navigator.permissions?.query) {
      return
    }

    let cancelled = false

    void navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((permissionStatus) => {
        if (cancelled || permissionStatus.state !== 'granted') {
          return
        }

        handleEnableLocation()
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!selectedPlaceId) {
      setPlacePreview(null)
      setPlacePreviewError(null)
      setPlacePreviewLoading(false)
      return
    }

    let cancelled = false

    setPlacePreviewLoading(true)
    setPlacePreviewError(null)

    void loadNearbyPlacePreview({
      data: {
        placeId: selectedPlaceId,
      },
    })
      .then((nextPreview) => {
        if (cancelled) {
          return
        }

        setPlacePreview(nextPreview)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        setPlacePreview(null)
        setPlacePreviewError(
          error instanceof Error
            ? error.message
            : 'Unable to load this place right now.',
        )
      })
      .finally(() => {
        if (!cancelled) {
          setPlacePreviewLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [loadNearbyPlacePreview, selectedPlaceId])

  const handleSaveProfile = async () => {
    if (!selectedPlace) {
      setSaveError('Choose your place before saving your intro.')
      return
    }

    setPendingAction('save')
    setSaveError(null)

    try {
      const nextProfile = await saveProfile({
        data: {
          moodEmoji,
          intentText,
          currentPlaceId: selectedPlace.placeId,
          tags: selectedTags,
        },
      })
      if (nextProfile.userId) {
        await refreshSession()
      }
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : 'Unable to save your intro right now.',
      )
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <main className="min-h-screen bg-[var(--rt-bg)] pb-10">
      <div className="mx-auto flex w-full max-w-xl flex-col">

        {/* ── Top header ── */}
        <header className="sticky top-0 z-40 flex items-center justify-between border-b border-[var(--rt-border)] bg-[var(--rt-bg)]/90 px-4 py-3 backdrop-blur-md">
          <p className="text-base font-black tracking-[-0.04em] text-[var(--rt-accent)]">TalkToMe</p>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={pendingAction === 'sign-out'}
            className="rounded-full border border-[var(--rt-border)] bg-[var(--rt-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--rt-ink-soft)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] disabled:opacity-60"
          >
            {pendingAction === 'sign-out' ? '...' : 'Sign out'}
          </button>
        </header>

        <div className="flex flex-col gap-4 px-4 pt-5">

          {/* ── Hero section ── */}
          {!selectedPlace ? (
            <div className="rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface)] p-5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--rt-ink-faint)]">Welcome back, {username}</p>
              <h1 className="mt-2 text-2xl font-black leading-tight tracking-[-0.05em] text-[var(--rt-ink)]">
                Open the door to a new connection.
              </h1>
              <p className="mt-2 text-sm leading-6 text-[var(--rt-ink-soft)]">
                Share your vibe and find someone nearby ready to listen or chat.
              </p>

              {/* Location button */}
              <button
                type="button"
                onClick={handleEnableLocation}
                disabled={locationStatus === 'requesting'}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--rt-accent)] px-5 py-3 font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)] disabled:opacity-70"
              >
                <MapPin className="h-4 w-4" />
                {locationStatus === 'requesting'
                  ? 'Checking location...'
                  : locationStatus === 'granted'
                  ? 'Refresh nearby places'
                  : 'Find places near me'}
              </button>

              {locationError ? (
                <p className="mt-3 text-xs text-rose-700">{locationError}</p>
              ) : null}

              {/* Privacy note */}
              <p className="mt-3 text-center text-[10px] text-[var(--rt-ink-faint)]">
                Your presence is only visible to people nearby
              </p>
            </div>
          ) : null}

          {/* ── Place chooser ── */}
          {isChoosingPlace ? (
            <div className="flex flex-col gap-3">
              {placesLoading ? (
                <div className="rounded-2xl border border-dashed border-[var(--rt-border)] bg-[var(--rt-surface)] px-4 py-6 text-center text-sm text-[var(--rt-ink-soft)]">
                  Finding nearby places...
                </div>
              ) : null}

              {!placesLoading && places.length > 0 ? (
                <>
                  {/* Quick stats */}
                  {totalReadyCount > 0 ? (
                    <div className="flex items-center gap-2 rounded-xl border border-[var(--rt-accent-soft)] bg-[var(--rt-accent-soft)] px-4 py-3">
                      <Users className="h-4 w-4 text-[var(--rt-accent)]" />
                      <p className="text-sm font-semibold text-[var(--rt-accent)]">
                        {totalReadyCount} {totalReadyCount === 1 ? 'person' : 'people'} ready to talk near you right now
                      </p>
                    </div>
                  ) : null}

                  <Suspense fallback={null}>
                    <NearbyPlacesMap
                      places={places}
                      selectedPlaceId={selectedPlaceId}
                      locationCoords={locationCoords}
                      onSelectPlace={setSelectedPlaceId}
                    />
                  </Suspense>

                  <div className="space-y-2">
                    {places.map((place) => (
                      <PlaceChoiceCard
                        key={place.placeId}
                        place={place}
                        isSelected={place.placeId === selectedPlaceId}
                        onSelect={() => setSelectedPlaceId(place.placeId)}
                      />
                    ))}
                  </div>
                </>
              ) : null}

              {!placesLoading && locationStatus === 'granted' && places.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--rt-border)] bg-[var(--rt-surface)] px-4 py-6 text-center text-sm text-[var(--rt-ink-soft)]">
                  No nearby places found. Try moving closer to a café or venue.
                </div>
              ) : null}

              {placesError ? <p className="text-sm text-rose-700">{placesError}</p> : null}
            </div>
          ) : null}

          {/* ── Selected place + profile setup ── */}
          {selectedPlace ? (
            <div className="flex flex-col gap-4">
              {/* Back button */}
              <button
                type="button"
                onClick={() => setSelectedPlaceId(null)}
                className="inline-flex items-center gap-2 self-start rounded-full border border-[var(--rt-border)] bg-[var(--rt-surface)] px-4 py-2 text-sm font-medium text-[var(--rt-ink-soft)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[var(--rt-ink)]"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to places
              </button>

              {/* Selected place card */}
              <div className="rounded-2xl border border-[var(--rt-accent)] bg-[var(--rt-accent-soft)] px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-bold text-[var(--rt-ink)]">{selectedPlace.name}</p>
                    <p className="mt-0.5 text-sm text-[var(--rt-ink-soft)]">{selectedPlace.address}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-[var(--rt-accent)]">
                    {selectedPlace.readyCount} ready
                  </span>
                </div>

                {/* Place preview */}
                {placePreview && placePreview.readyParticipants.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {placePreview.readyParticipants.map((participant) => (
                      <div key={participant.userId} className="rounded-xl border border-[var(--rt-border)] bg-white/90 px-3 py-2.5">
                        <p className="text-sm font-semibold text-[var(--rt-ink)]">{participant.moodEmoji} {participant.username}</p>
                        {participant.intentSummary ? (
                          <p className="mt-0.5 text-xs text-[var(--rt-ink-soft)]">"{participant.intentSummary}"</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {placePreviewLoading ? <p className="mt-2 text-xs text-[var(--rt-ink-faint)]">Loading preview...</p> : null}
              </div>

              {/* ── CHOOSE YOUR CURRENT VIBE ── */}
              <div className="rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface)] p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--rt-ink-faint)]">Choose your current vibe</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {MOOD_OPTIONS.map((option) => {
                    const isSelected = option.emoji === moodEmoji
                    return (
                      <button
                        key={option.emoji}
                        type="button"
                        onClick={() => setMoodEmoji(option.emoji)}
                        aria-pressed={isSelected}
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-2 text-sm font-semibold transition-[background-color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.95] ${
                          isSelected
                            ? 'border-[var(--rt-accent)] bg-[var(--rt-accent)] text-white'
                            : 'border-[var(--rt-border)] bg-white text-[var(--rt-ink-soft)] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)]'
                        }`}
                      >
                        <span>{option.emoji}</span>
                        <span>{option.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* ── WHAT'S ON YOUR MIND ── */}
              <div className="rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface)] p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--rt-ink-faint)]">What's on your mind?</p>
                <textarea
                  value={intentText}
                  onChange={(e) => setIntentText(e.target.value)}
                  rows={3}
                  maxLength={120}
                  placeholder="Coffee break, startup ideas, open to anything..."
                  className="mt-2 w-full rounded-xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-3 py-2.5 text-sm text-[var(--rt-ink)] outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-[var(--rt-ink-faint)] focus:border-[var(--rt-accent)] focus:ring-2 focus:ring-[var(--rt-accent-soft)]"
                />
                <p className="mt-1 text-right text-xs text-[var(--rt-ink-faint)]">{intentText.length}/120 · This helps others start a conversation with you.</p>
              </div>

              {/* ── INTEREST TAGS ── */}
              <div className="rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface)] p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--rt-ink-faint)]">Your interests <span className="normal-case font-normal">(pick up to 4)</span></p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {TAG_OPTIONS.map((tag) => {
                    const isSelected = selectedTags.includes(tag)
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          setSelectedTags((prev) =>
                            prev.includes(tag)
                              ? prev.filter((t) => t !== tag)
                              : prev.length < 4
                              ? [...prev, tag]
                              : prev,
                          )
                        }}
                        aria-pressed={isSelected}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-[background-color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.96] ${
                          isSelected
                            ? 'border-[var(--rt-accent)] bg-[var(--rt-accent)] text-white'
                            : 'border-[var(--rt-border)] bg-white text-[var(--rt-ink-soft)] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)]'
                        }`}
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* ── CTA ── */}
              {saveError ? (
                <p className="text-sm text-rose-700">{saveError}</p>
              ) : null}

              <button
                type="button"
                onClick={handleSaveProfile}
                disabled={pendingAction === 'save' || placePreviewLoading}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--rt-accent)] px-5 py-3.5 font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)] disabled:opacity-70"
              >
                {pendingAction === 'save' ? 'Joining...' : 'Join the Space →'}
              </button>

              <p className="text-center text-xs text-[var(--rt-ink-faint)]">
                Joining <span className="font-medium text-[var(--rt-ink-soft)]">{selectedPlace.name}</span>
              </p>
            </div>
          ) : null}

        </div>
      </div>
    </main>
  )
}

function PlaceChoiceCard({
  place,
  isSelected,
  onSelect,
}: {
  place: NearbyPlace
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rt-card-stagger w-full rounded-3xl border px-4 py-4 text-left transition-[background-color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.98] ${
        isSelected
          ? 'border-[var(--rt-accent)] bg-[var(--rt-accent)] text-white shadow-lg'
          : 'border-[var(--rt-border)] bg-white/86 text-[var(--rt-ink)] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)]'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold">{place.name}</p>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
            isSelected
              ? 'bg-white/15 text-white'
              : place.readyCount > 0
                ? 'bg-[var(--rt-accent-soft)] text-[var(--rt-accent)]'
                : 'bg-[var(--rt-bg-strong)] text-[var(--rt-ink-soft)]'
          }`}
        >
          {place.readyCount === 1 ? '1 ready' : `${place.readyCount} ready`}
        </span>
      </div>
      <p
        className={`mt-1 text-sm leading-6 ${
          isSelected ? 'text-white/80' : 'text-[var(--rt-ink-soft)]'
        }`}
      >
        {place.address}
      </p>
      <p
        className={`mt-3 text-xs font-medium uppercase tracking-[0.16em] ${
          isSelected ? 'text-white/65' : 'text-[var(--rt-ink-soft)]'
        }`}
      >
        {place.readyCount > 0 ? 'People are ready here now' : 'Quiet right now'}
      </p>
    </button>
  )
}
