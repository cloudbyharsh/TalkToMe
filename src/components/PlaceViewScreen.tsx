import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useAgent } from 'agents/react'
import {
  AlertCircle,
  ArrowLeft,
  BellRing,
  Check,
  LocateFixed,
  MapPin,
  MessageCircle,
  Radio,
  Send,
  Users,
  X,
} from 'lucide-react'
import { authClient } from '../lib/auth-client'
import type {
  ActiveConnectionState,
  AppSession,
  ConnectRequestMessage,
  CurrentPlaceState,
  IncomingConnectRequest,
  PlaceAgentState,
  UserProfileState,
} from '../lib/app-types'
import type { PlaceAgent } from '../lib/server/agents/place-agent'

const MAX_MESSAGES_PER_USER = 3

type AuthResult = {
  error?: {
    message?: string | null
  } | null
}

type PlaceViewClientLike = {
  signOut: () => Promise<AuthResult>
}

type ConversationNoticeState = {
  title: string
  description: string
}

type MotionAccessState =
  | 'unavailable'
  | 'needs-permission'
  | 'requesting'
  | 'active'
  | 'denied'

type MotionPermissionResponse = 'granted' | 'denied'

type DeviceMotionEventWithPermission = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<MotionPermissionResponse>
}

const FACE_DOWN_HORIZONTAL_THRESHOLD = 4
const FACE_DOWN_Z_THRESHOLD = -7
const FACE_DOWN_HOLD_MS = 1200
const MOTION_ARM_DELAY_MS = 1500

const finderHintOptions = [
  'Front tables',
  'Counter',
  'Window seats',
  'Patio',
  'Back corner',
] as const

function getInitialMotionAccessState(): MotionAccessState {
  if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) {
    return 'unavailable'
  }

  const motionEvent = window.DeviceMotionEvent as
    | DeviceMotionEventWithPermission
    | undefined

  if (!motionEvent) {
    return 'unavailable'
  }

  return typeof motionEvent.requestPermission === 'function'
    ? 'needs-permission'
    : 'active'
}

function isFaceDownReading(
  acceleration: DeviceMotionEvent['accelerationIncludingGravity'] | null,
) {
  if (!acceleration) return false
  const { x, y, z } = acceleration
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
    return false
  }
  return (
    Math.abs(x) <= FACE_DOWN_HORIZONTAL_THRESHOLD &&
    Math.abs(y) <= FACE_DOWN_HORIZONTAL_THRESHOLD &&
    z <= FACE_DOWN_Z_THRESHOLD
  )
}

async function playFinderCue() {
  if (typeof window !== 'undefined') {
    const AudioContextCtor =
      window.AudioContext ||
      ('webkitAudioContext' in window
        ? ((window as Window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext ?? null)
        : null)

    if (AudioContextCtor) {
      try {
        const audioContext = new AudioContextCtor()
        const oscillator = audioContext.createOscillator()
        const gain = audioContext.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(880, audioContext.currentTime)
        oscillator.frequency.exponentialRampToValueAtTime(1320, audioContext.currentTime + 0.18)
        gain.gain.setValueAtTime(0.0001, audioContext.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.06, audioContext.currentTime + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.28)
        oscillator.connect(gain)
        gain.connect(audioContext.destination)
        oscillator.start()
        oscillator.stop(audioContext.currentTime + 0.3)
        window.setTimeout(() => void audioContext.close().catch(() => undefined), 450)
      } catch {
        // Ignore blocked audio contexts.
      }
    }
  }

  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate?.([120, 80, 140])
  }
}

export function PlaceViewScreen({
  session,
  profile,
  currentPlace,
  activeConnection,
  pendingIncomingRequests,
  refreshSession,
  setReady,
  saveFinderProfile,
  leavePlace,
  pingParticipant,
  sendConnectRequest,
  addRequestMessage,
  respondToRequest,
  endConversation,
  client = authClient,
}: {
  session: AppSession
  profile: UserProfileState
  currentPlace: CurrentPlaceState
  activeConnection: ActiveConnectionState | null
  pendingIncomingRequests: IncomingConnectRequest[]
  refreshSession: () => Promise<void>
  setReady: (input: { data: { ready: boolean } }) => Promise<void>
  saveFinderProfile: (input: {
    data: { isFindable: boolean; locationHint: string | null }
  }) => Promise<UserProfileState>
  leavePlace: () => Promise<void>
  pingParticipant: (input: { data: { userId: string } }) => Promise<unknown>
  sendConnectRequest: (input: {
    data: { recipientUserId: string; introMessage: string }
  }) => Promise<unknown>
  addRequestMessage: (input: {
    data: { requestId: string; body: string }
  }) => Promise<unknown>
  respondToRequest: (input: {
    data: { requestId: string; accept: boolean }
  }) => Promise<unknown>
  endConversation: () => Promise<unknown>
  client?: PlaceViewClientLike
}) {
  const [pendingAction, setPendingAction] = useState<
    | 'ready'
    | 'finder'
    | 'leave'
    | 'sign-out'
    | 'connect'
    | 'respond'
    | 'end-connection'
    | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [finderNotice, setFinderNotice] = useState<ConversationNoticeState | null>(null)
  const [livePlaceState, setLivePlaceState] = useState<PlaceAgentState | null>(null)
  const [conversationNotice, setConversationNotice] = useState<ConversationNoticeState | null>(null)
  const [conversationNow, setConversationNow] = useState(() => Date.now())
  const [pendingPingUserId, setPendingPingUserId] = useState<string | null>(null)
  const [selectedFinderHint, setSelectedFinderHint] = useState(
    profile.locationHint ?? finderHintOptions[0],
  )
  const [motionAccessState, setMotionAccessState] = useState<MotionAccessState>(
    () => getInitialMotionAccessState(),
  )
  const [motionNotice, setMotionNotice] = useState<string | null>(null)

  // Connect request send state
  const [connectModalTarget, setConnectModalTarget] = useState<{
    userId: string
    username: string
    moodEmoji: string | null
    intentSummary: string | null
  } | null>(null)
  const [introMessage, setIntroMessage] = useState('')
  const [connectError, setConnectError] = useState<string | null>(null)

  // Incoming request reply state (keyed by requestId)
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({})
  const [pendingReplyRequestId, setPendingReplyRequestId] = useState<string | null>(null)
  const [replyError, setReplyError] = useState<string | null>(null)
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null)
  const [acceptedRequestThread, setAcceptedRequestThread] = useState<{
    introMessage: string | null
    messages: ConnectRequestMessage[]
  } | null>(null)

  const readyRequestInFlightRef = useRef(false)
  const motionArmedRef = useRef(false)
  const motionIgnoreUntilRef = useRef(0)
  const faceDownSinceRef = useRef<number | null>(null)
  const previousConnectionRef = useRef<ActiveConnectionState | null>(activeConnection)
  const previousPingRef = useRef<string | null>(profile.pingRequestedAt?.toString() ?? null)

  const placeAgent = useAgent<PlaceAgent, PlaceAgentState>({
    agent: 'place-agent',
    name: currentPlace.place.placeId,
    onStateUpdate: (nextState) => {
      setLivePlaceState(nextState)
    },
  })
  void placeAgent

  const username =
    session.user.displayUsername || session.user.username || session.user.name
  const liveParticipant =
    livePlaceState?.participants?.find((p) => p.userId === session.user.id) ?? null
  const liveConnection =
    livePlaceState?.connections?.find(
      (c) =>
        c.requesterUserId === session.user.id ||
        c.recipientUserId === session.user.id,
    ) ?? null
  const counterpartParticipant =
    liveConnection && livePlaceState
      ? livePlaceState.participants.find(
          (p) =>
            p.userId !== session.user.id &&
            (p.userId === liveConnection.requesterUserId ||
              p.userId === liveConnection.recipientUserId),
        ) ?? null
      : null
  const liveStatus = liveParticipant?.status ?? profile.status
  const isFindable = liveParticipant?.isFindable ?? profile.isFindable
  const locationHint = liveParticipant?.locationHint ?? profile.locationHint
  const activePingRequestedAt =
    liveParticipant?.pingRequestedAt ?? profile.pingRequestedAt
  const activePingRequestedByUsername =
    liveParticipant?.pingRequestedByUsername ?? profile.pingRequestedByUsername
  const resolvedActiveConnection =
    liveParticipant && livePlaceState
      ? liveConnection && counterpartParticipant
        ? {
            id: liveConnection.id,
            placeId: currentPlace.place.placeId,
            createdAt: liveConnection.createdAt,
            counterpart: {
              userId: counterpartParticipant.userId,
              username: counterpartParticipant.username,
              moodEmoji: counterpartParticipant.moodEmoji,
              intentSummary: counterpartParticipant.intentSummary,
            },
          }
        : null
      : activeConnection
  const isReady = liveStatus === 'ready'
  const isInConversation = liveStatus === 'in_conversation'
  const liveParticipants =
    livePlaceState?.placeId === currentPlace.place.placeId
      ? livePlaceState.participants
      : []
  const readyParticipants = [...liveParticipants]
    .filter((p) => p.status === 'ready')
    .sort((a, b) => {
      if (a.userId === session.user.id) return -1
      if (b.userId === session.user.id) return 1
      return a.username.localeCompare(b.username)
    })
  const findableParticipants = readyParticipants.filter(
    (p) => p.userId !== session.user.id && p.isFindable,
  )
  const presentParticipants = liveParticipants.filter((p) => p.status === 'present')
  const activeConversationCount =
    livePlaceState?.placeId === currentPlace.place.placeId
      ? livePlaceState.connections.length
      : 0
  const readyCount =
    livePlaceState?.placeId === currentPlace.place.placeId
      ? livePlaceState.readyCount
      : currentPlace.readyCount
  const checkedInCount =
    livePlaceState?.placeId === currentPlace.place.placeId
      ? livePlaceState.checkedInCount
      : Math.max(currentPlace.readyCount, readyParticipants.length)
  const conversationElapsed =
    resolvedActiveConnection !== null
      ? formatConversationElapsed(resolvedActiveConnection.createdAt, conversationNow)
      : null

  useEffect(() => {
    setLivePlaceState(null)
  }, [currentPlace.place.placeId])

  useEffect(() => {
    setMotionAccessState(getInitialMotionAccessState())
  }, [])

  useEffect(() => {
    if (resolvedActiveConnection) {
      previousConnectionRef.current = resolvedActiveConnection
      setConversationNotice(null)
      return
    }
    const previousConnection = previousConnectionRef.current
    if (!previousConnection) return
    previousConnectionRef.current = null
    setConversationNotice({
      title: 'Conversation ended',
      description:
        liveStatus === 'ready'
          ? `You and ${previousConnection.counterpart.username} are back in the ready pool.`
          : `You and ${previousConnection.counterpart.username} are no longer connected. Set yourself ready again whenever you want.`,
    })
  }, [liveStatus, resolvedActiveConnection])

  useEffect(() => {
    if (!conversationNotice) return
    const id = window.setTimeout(() => setConversationNotice(null), 5000)
    return () => window.clearTimeout(id)
  }, [conversationNotice])

  useEffect(() => {
    if (!finderNotice) return
    const id = window.setTimeout(() => setFinderNotice(null), 5000)
    return () => window.clearTimeout(id)
  }, [finderNotice])

  useEffect(() => {
    if (!motionNotice) return
    const id = window.setTimeout(() => setMotionNotice(null), 4000)
    return () => window.clearTimeout(id)
  }, [motionNotice])

  useEffect(() => {
    if (!resolvedActiveConnection) return
    setConversationNow(Date.now())
    const id = window.setInterval(() => setConversationNow(Date.now()), 30000)
    return () => window.clearInterval(id)
  }, [resolvedActiveConnection?.id])

  useEffect(() => {
    if (locationHint) setSelectedFinderHint(locationHint)
  }, [locationHint])

  // Auto-poll for incoming requests and message updates while the user is
  // present/ready (not in a conversation). This keeps the request card and
  // thread messages live without needing a manual page refresh.
  useEffect(() => {
    if (isInConversation) return
    const id = window.setInterval(() => {
      void refreshSession()
    }, 6000)
    return () => window.clearInterval(id)
  }, [isInConversation])

  useEffect(() => {
    const nextPingValue = activePingRequestedAt?.toString() ?? null
    if (!nextPingValue || previousPingRef.current === nextPingValue) return
    previousPingRef.current = nextPingValue
    const pingTimestamp = new Date(nextPingValue).getTime()
    if (!Number.isFinite(pingTimestamp) || Date.now() - pingTimestamp > 15000) return
    setFinderNotice({
      title: 'Someone is trying to find you',
      description: activePingRequestedByUsername
        ? `${activePingRequestedByUsername} is looking for you. Head over when you're ready.`
        : 'Someone nearby is looking for you.',
    })
    void playFinderCue()
  }, [activePingRequestedAt, activePingRequestedByUsername])

  const updateReadyState = async (
    nextReady: boolean,
    source: 'manual' | 'face-down' = 'manual',
  ) => {
    if (readyRequestInFlightRef.current || nextReady === isReady) return
    readyRequestInFlightRef.current = true
    setPendingAction('ready')
    setError(null)
    try {
      await setReady({ data: { ready: nextReady } })
      await refreshSession()
      if (source === 'face-down') {
        setMotionNotice('Phone turned face-down. You are no longer marked ready.')
      }
    } catch (nextError) {
      setMotionNotice(null)
      setError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to change your status right now.',
      )
    } finally {
      readyRequestInFlightRef.current = false
      motionArmedRef.current = false
      motionIgnoreUntilRef.current = nextReady ? Date.now() + MOTION_ARM_DELAY_MS : 0
      faceDownSinceRef.current = null
      setPendingAction(null)
    }
  }

  const handleDeviceMotion = useEffectEvent((event: DeviceMotionEvent) => {
    if (!isReady || isInConversation || readyRequestInFlightRef.current) {
      motionArmedRef.current = false
      faceDownSinceRef.current = null
      return
    }
    const now = Date.now()
    const isFaceDown = isFaceDownReading(event.accelerationIncludingGravity)
    if (now < motionIgnoreUntilRef.current) {
      faceDownSinceRef.current = null
      return
    }
    if (!motionArmedRef.current) {
      if (!isFaceDown) motionArmedRef.current = true
      faceDownSinceRef.current = null
      return
    }
    if (!isFaceDown) {
      faceDownSinceRef.current = null
      return
    }
    if (faceDownSinceRef.current === null) {
      faceDownSinceRef.current = now
      return
    }
    if (now - faceDownSinceRef.current < FACE_DOWN_HOLD_MS) return
    faceDownSinceRef.current = null
    void updateReadyState(false, 'face-down')
  })

  useEffect(() => {
    if (!isReady || isInConversation || motionAccessState !== 'active' || typeof window === 'undefined') {
      motionArmedRef.current = false
      motionIgnoreUntilRef.current = 0
      faceDownSinceRef.current = null
      return
    }
    motionArmedRef.current = false
    motionIgnoreUntilRef.current = Date.now() + MOTION_ARM_DELAY_MS
    faceDownSinceRef.current = null
    window.addEventListener('devicemotion', handleDeviceMotion)
    return () => window.removeEventListener('devicemotion', handleDeviceMotion)
  }, [isReady, isInConversation, motionAccessState])

  const handleReadyToggle = async () => {
    await updateReadyState(!isReady)
  }

  const handleLeavePlace = async () => {
    setPendingAction('leave')
    setError(null)
    try {
      await leavePlace()
      await refreshSession()
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : 'Unable to switch places right now.',
      )
    } finally {
      setPendingAction(null)
    }
  }

  const saveFinderState = async (nextIsFindable: boolean, nextLocationHint: string) => {
    setPendingAction('finder')
    setError(null)
    try {
      await saveFinderProfile({ data: { isFindable: nextIsFindable, locationHint: nextLocationHint } })
      await refreshSession()
      setFinderNotice({
        title: nextIsFindable ? 'Finder mode is on' : 'Finder mode is off',
        description: nextIsFindable
          ? `People nearby can look for you around ${nextLocationHint}.`
          : 'You are no longer sharing a spot in this place.',
      })
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to update your finder settings right now.',
      )
    } finally {
      setPendingAction(null)
    }
  }

  const handleFinderToggle = async () => {
    await saveFinderState(!isFindable, selectedFinderHint)
  }

  const handleSelectFinderHint = async (nextHint: string) => {
    setSelectedFinderHint(nextHint)
    if (!isFindable) return
    await saveFinderState(true, nextHint)
  }

  const handleSignOut = async () => {
    setPendingAction('sign-out')
    setError(null)
    const result = await client.signOut()
    if (result.error) {
      setError(result.error.message || 'Unable to sign out right now.')
      setPendingAction(null)
      return
    }
    await refreshSession()
    setPendingAction(null)
  }

  const handleEndConnection = async () => {
    setPendingAction('end-connection')
    setError(null)
    try {
      await endConversation()
      await refreshSession()
      setAcceptedRequestThread(null)
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to end that connection right now.',
      )
    } finally {
      setPendingAction(null)
    }
  }

  const handlePingParticipant = async (
    participant: PlaceAgentState['participants'][number],
  ) => {
    setPendingPingUserId(participant.userId)
    setError(null)
    try {
      await pingParticipant({ data: { userId: participant.userId } })
      setFinderNotice({
        title: 'Ping sent',
        description: `A quick cue was sent to ${participant.username} near ${participant.locationHint || 'their shared spot'}.`,
      })
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : 'Unable to send that ping right now.',
      )
    } finally {
      setPendingPingUserId(null)
    }
  }

  const handleEnableMotionAccess = async () => {
    if (typeof window === 'undefined') return
    const motionEvent = window.DeviceMotionEvent as DeviceMotionEventWithPermission | undefined
    if (!motionEvent) {
      setMotionAccessState('unavailable')
      return
    }
    if (!motionEvent.requestPermission) {
      setMotionAccessState('active')
      motionArmedRef.current = false
      motionIgnoreUntilRef.current = Date.now() + MOTION_ARM_DELAY_MS
      return
    }
    setMotionAccessState('requesting')
    try {
      const permission = await motionEvent.requestPermission()
      if (permission === 'granted') {
        setMotionAccessState('active')
        motionArmedRef.current = false
        motionIgnoreUntilRef.current = Date.now() + MOTION_ARM_DELAY_MS
        setMotionNotice('Flip your phone face-down to leave the ready pool.')
        return
      }
      setMotionAccessState('denied')
    } catch {
      setMotionAccessState('denied')
    }
  }

  // Connect request send handlers
  const handleOpenConnectModal = (participant: PlaceAgentState['participants'][number]) => {
    setConnectModalTarget({
      userId: participant.userId,
      username: participant.username,
      moodEmoji: participant.moodEmoji,
      intentSummary: participant.intentSummary,
    })
    setIntroMessage('')
    setConnectError(null)
  }

  const handleCloseConnectModal = () => {
    setConnectModalTarget(null)
    setIntroMessage('')
    setConnectError(null)
  }

  const handleSendConnectRequest = async () => {
    if (!connectModalTarget) return
    setPendingAction('connect')
    setConnectError(null)
    try {
      await sendConnectRequest({
        data: {
          recipientUserId: connectModalTarget.userId,
          introMessage,
        },
      })
      handleCloseConnectModal()
      await refreshSession()
    } catch (nextError) {
      setConnectError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to send that request right now.',
      )
    } finally {
      setPendingAction(null)
    }
  }

  // Incoming request reply handlers
  const handleSendReply = async (requestId: string) => {
    const body = (replyDrafts[requestId] ?? '').trim()
    if (!body) return
    setPendingReplyRequestId(requestId)
    setReplyError(null)
    try {
      await addRequestMessage({ data: { requestId, body } })
      setReplyDrafts((prev) => ({ ...prev, [requestId]: '' }))
      await refreshSession()
    } catch (nextError) {
      setReplyError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to send that message right now.',
      )
    } finally {
      setPendingReplyRequestId(null)
    }
  }

  const handleRespondToRequest = async (requestId: string, accept: boolean) => {
    setRespondingRequestId(requestId)
    setPendingAction('respond')
    setError(null)
    try {
      if (accept) {
        // Capture the thread before the request disappears from the pending list
        const req = pendingIncomingRequests.find((r) => r.id === requestId)
        if (req) {
          setAcceptedRequestThread({
            introMessage: req.introMessage ?? null,
            messages: req.messages,
          })
        }
      }
      await respondToRequest({ data: { requestId, accept } })
      if (accept) {
        setConversationNotice({
          title: "You're talking now.",
          description: 'Meet in person when ready.',
        })
      }
      await refreshSession()
    } catch (nextError) {
      setAcceptedRequestThread(null)
      setError(
        nextError instanceof Error
          ? nextError.message
          : 'Unable to respond to that request right now.',
      )
    } finally {
      setRespondingRequestId(null)
      setPendingAction(null)
    }
  }

  return (
    <main className="min-h-screen px-4 py-5 sm:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] w-full max-w-xl flex-col gap-4">
        <section className="rounded-[2rem] border border-[var(--rt-border)] bg-[var(--rt-surface)] p-5 shadow-[0_28px_80px_rgba(17,52,44,0.12)] backdrop-blur-xl sm:p-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--rt-border-strong)] bg-[var(--rt-accent-soft)] px-4 py-2 text-sm font-medium text-[var(--rt-accent)] shadow-sm">
            <Radio className="h-4 w-4" />
            Live place
          </div>

          <h1 className="mt-5 text-4xl font-black leading-none tracking-[-0.05em] text-[var(--rt-ink)] sm:text-5xl">
            {currentPlace.place.name}
          </h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-[var(--rt-ink-soft)] sm:text-lg">
            You are here as {username}. Go ready when you want to meet someone,
            then send a request to talk to start the conversation.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <MetricCard
              icon={<Users className="h-5 w-5" />}
              label="Ready right now"
              value={String(readyCount)}
              tone="amber"
            />
            <MetricCard
              icon={<Radio className="h-5 w-5" />}
              label="Checked in now"
              value={String(checkedInCount)}
              tone="slate"
            />
            <MetricCard
              icon={<MapPin className="h-5 w-5" />}
              label="Your state"
              value={isInConversation ? 'Talking' : isReady ? 'Ready' : 'Present'}
              tone={isInConversation ? 'amber' : isReady ? 'emerald' : 'slate'}
            />
          </div>

          <div className="mt-8 rounded-[2rem] border border-[var(--rt-border)] bg-white/82 p-6 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--rt-ink-soft)]">
              Your intro
            </p>
            <p className="mt-4 text-2xl font-semibold text-[var(--rt-ink)]">
              {profile.moodEmoji} {profile.intentSummary}
            </p>
            <p className="mt-3 text-sm leading-6 text-[var(--rt-ink-soft)]">
              {currentPlace.place.address}
            </p>
          </div>

          {/* Incoming connect requests */}
          {pendingIncomingRequests.length > 0 ? (
            <div className="rt-notice mt-6 rounded-[2rem] border border-[var(--rt-accent)] bg-[var(--rt-accent-soft)] p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl border border-[var(--rt-accent)] bg-white p-3 text-[var(--rt-accent)]">
                  <MessageCircle className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-[var(--rt-ink)]">
                    {pendingIncomingRequests.length === 1
                      ? '1 request to talk'
                      : `${pendingIncomingRequests.length} requests to talk`}
                  </p>
                  <p className="text-sm leading-6 text-[var(--rt-ink-soft)]">
                    Someone nearby wants to meet you. Accept or decline below.
                  </p>
                </div>
              </div>

              <div className="mt-5 space-y-4">
                {pendingIncomingRequests.map((req) => (
                  <IncomingRequestCard
                    key={req.id}
                    request={req}
                    currentUserId={session.user.id}
                    isResponding={respondingRequestId === req.id}
                    isSendingReply={pendingReplyRequestId === req.id}
                    replyDraft={replyDrafts[req.id] ?? ''}
                    replyError={replyError}
                    onReplyDraftChange={(val) =>
                      setReplyDrafts((prev) => ({ ...prev, [req.id]: val }))
                    }
                    onSendReply={() => void handleSendReply(req.id)}
                    onAccept={() => void handleRespondToRequest(req.id, true)}
                    onReject={() => void handleRespondToRequest(req.id, false)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {/* Who is ready here */}
          <div className="mt-6 rounded-[2rem] border border-[var(--rt-border)] bg-white/82 p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--rt-ink-soft)]">
                  Who is ready here
                </p>
                <p className="mt-2 text-sm leading-6 text-[var(--rt-ink-soft)]">
                  Tap Request to talk on someone to send them an intro and start the conversation.
                </p>
              </div>
              <div className="rounded-full bg-[var(--rt-accent-soft)] px-3 py-1 text-sm font-semibold text-[var(--rt-accent)]">
                {readyCount} ready
              </div>
            </div>

            {readyParticipants.length > 0 ? (
              <div className="mt-5 space-y-3">
                {readyParticipants.map((participant, index) => (
                  <PresencePersonCard
                    key={participant.userId}
                    participant={participant}
                    isCurrentUser={participant.userId === session.user.id}
                    isInConversation={isInConversation}
                    staggerIndex={index}
                    onConnect={
                      participant.userId === session.user.id || isInConversation
                        ? null
                        : () => handleOpenConnectModal(participant)
                    }
                    onPing={
                      participant.userId === session.user.id || !participant.isFindable
                        ? null
                        : () => void handlePingParticipant(participant)
                    }
                    isPinging={pendingPingUserId === participant.userId}
                  />
                ))}
              </div>
            ) : (
              <div className="rt-card-stagger mt-5 flex flex-col items-center gap-2 rounded-3xl border border-dashed border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-4 py-8 text-center">
                <Users className="h-5 w-5 text-[var(--rt-border-strong)]" />
                <p className="text-sm text-[var(--rt-ink-soft)]">No one is ready here yet.</p>
                <p className="text-xs text-[var(--rt-ink-soft)]/70">Set yourself ready above to be the first.</p>
              </div>
            )}

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <PresenceSummaryCard
                label="Taking a moment"
                count={presentParticipants.length}
                description="Checked in here, but not in the ready pool."
              />
              <PresenceSummaryCard
                label="Talking now"
                count={activeConversationCount}
                description="Active conversations happening in this place."
              />
              <PresenceSummaryCard
                label="Easy to find"
                count={findableParticipants.length}
                description="Ready people who shared a spot and can be pinged."
              />
            </div>
          </div>
        </section>

        <section className="rounded-[2rem] border border-[var(--rt-border)] bg-[var(--rt-surface)] p-6 shadow-[0_24px_80px_rgba(17,52,44,0.12)] sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm uppercase tracking-[0.24em] text-[var(--rt-accent)]">
                Place View
              </p>
              <h2 className="mt-2 text-3xl font-bold text-[var(--rt-ink)]">
                Ready when you want
              </h2>
            </div>

            <button
              type="button"
              onClick={handleSignOut}
              disabled={pendingAction === 'sign-out'}
              className="rounded-full border border-[var(--rt-border)] bg-white/80 px-4 py-2 text-sm font-medium text-[var(--rt-ink-soft)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[var(--rt-ink)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pendingAction === 'sign-out' ? 'Signing out...' : 'Sign out'}
            </button>
          </div>

          <div className="mt-6 rounded-3xl border border-[var(--rt-border)] bg-[var(--rt-accent-soft)] p-5">
            <p className="text-sm font-semibold text-[var(--rt-ink)]">Status</p>
            <p className="mt-2 text-sm leading-6 text-[var(--rt-ink-soft)]">
              {isInConversation
                ? `You are currently talking${resolvedActiveConnection ? ` with ${resolvedActiveConnection.counterpart.username}` : ''}.`
                : isReady
                ? 'You are visible in the ready count. Others can send you a request to talk.'
                : 'You are present here, but not yet in the ready count.'}
            </p>

            {isInConversation ? (
              <button
                type="button"
                onClick={handleEndConnection}
                disabled={pendingAction === 'end-connection'}
                className="mt-4 inline-flex w-full items-center justify-center rounded-2xl bg-[var(--rt-accent)] px-5 py-3 font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {pendingAction === 'end-connection' ? 'Ending conversation...' : 'I am free again'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleReadyToggle}
                disabled={pendingAction === 'ready'}
                className={`mt-4 inline-flex w-full items-center justify-center rounded-2xl px-5 py-3 font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-70 ${
                  isReady
                    ? 'bg-rose-500 hover:bg-rose-600'
                    : 'bg-[var(--rt-accent)] hover:bg-[var(--rt-accent-strong)]'
                }`}
              >
                {pendingAction === 'ready'
                  ? 'Updating status...'
                  : isReady
                  ? 'Leave ready pool'
                  : 'Set me ready'}
              </button>
            )}

            {!isInConversation ? (
              <div className="mt-4 rounded-2xl border border-dashed border-[var(--rt-border)] bg-white px-4 py-4">
                <p className="text-sm font-semibold text-[var(--rt-ink)]">Phone flip shortcut</p>
                <p className="mt-2 text-sm leading-6 text-[var(--rt-ink-soft)]">
                  {motionAccessState === 'active'
                    ? isReady
                      ? 'Flip your phone face-down for a moment to leave the ready pool without tapping.'
                      : 'When you are ready, flipping your phone face-down can take you back out of the ready pool.'
                    : motionAccessState === 'needs-permission' || motionAccessState === 'requesting'
                    ? 'Allow motion access once so turning your phone face-down can quietly take you out of the ready pool.'
                    : motionAccessState === 'denied'
                    ? 'Motion access is still off, so face-down detection cannot change your status yet.'
                    : 'Face-down detection is not available in this browser.'}
                </p>

                {(motionAccessState === 'needs-permission' ||
                  motionAccessState === 'requesting' ||
                  motionAccessState === 'denied') && (
                  <button
                    type="button"
                    onClick={() => void handleEnableMotionAccess()}
                    disabled={motionAccessState === 'requesting'}
                    className="mt-4 inline-flex items-center justify-center rounded-full border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-4 py-2 text-sm font-medium text-[var(--rt-ink)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {motionAccessState === 'requesting'
                      ? 'Enabling motion access...'
                      : motionAccessState === 'denied'
                      ? 'Try motion access again'
                      : 'Enable face-down shortcut'}
                  </button>
                )}

                {motionNotice ? (
                  <p className="mt-3 text-sm font-medium text-[var(--rt-accent)]">{motionNotice}</p>
                ) : null}
              </div>
            ) : null}
          </div>

          {conversationNotice ? (
            <div className="rt-conversation-notice mt-6 flex items-start gap-3 rounded-3xl border p-5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 opacity-90" />
              <div>
                <p className="text-sm font-semibold">{conversationNotice.title}</p>
                <p className="mt-1 text-sm leading-6 opacity-90">{conversationNotice.description}</p>
              </div>
            </div>
          ) : null}

          {finderNotice ? (
            <div className="rt-notice mt-6 rounded-3xl border border-[var(--rt-border-strong)] bg-[var(--rt-accent-soft)] p-5 text-[var(--rt-ink)]">
              <p className="text-sm font-semibold">{finderNotice.title}</p>
              <p className="mt-2 text-sm leading-6">{finderNotice.description}</p>
            </div>
          ) : null}

          <div className="mt-6 rounded-3xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] p-5">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl border border-[var(--rt-border)] bg-white p-3 text-[var(--rt-accent)]">
                <LocateFixed className="h-6 w-6" />
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--rt-ink)]">Help someone find you</p>
                <p className="text-sm leading-6 text-[var(--rt-ink-soft)]">
                  Share one simple spot in this place so someone can look for you before connecting.
                </p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {finderHintOptions.map((hint) => {
                const isSelected = selectedFinderHint === hint
                return (
                  <button
                    key={hint}
                    type="button"
                    onClick={() => void handleSelectFinderHint(hint)}
                    disabled={!isReady || isInConversation || pendingAction === 'finder'}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition-[background-color,color,border-color,transform] duration-150 ease-out active:scale-[0.96] ${
                      isSelected
                        ? 'bg-[var(--rt-accent)] text-white'
                        : 'border border-[var(--rt-border)] bg-white text-[var(--rt-ink-soft)] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[var(--rt-ink)]'
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    {hint}
                  </button>
                )
              })}
            </div>

            <div className="mt-4 rounded-2xl border border-[var(--rt-border)] bg-white px-4 py-4">
              <p className="text-sm font-semibold text-[var(--rt-ink)]">
                {isFindable
                  ? `Currently sharing: ${selectedFinderHint}`
                  : isInConversation
                  ? 'Finder mode pauses while you are talking.'
                  : isReady
                  ? 'Pick the spot that best matches where you are.'
                  : 'Set yourself ready before sharing a spot.'}
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--rt-ink-soft)]">
                {isFindable
                  ? 'People nearby can look for this hint and send a quick cue to your phone.'
                  : 'This stays off until you choose to share it.'}
              </p>
            </div>

            <button
              type="button"
              onClick={() => void handleFinderToggle()}
              disabled={!isReady || isInConversation || pendingAction === 'finder'}
              className={`mt-4 inline-flex w-full items-center justify-center rounded-2xl px-5 py-3 font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-70 ${
                isFindable
                  ? 'bg-rose-500 hover:bg-rose-600'
                  : 'bg-[var(--rt-accent)] hover:bg-[var(--rt-accent-strong)]'
              }`}
            >
              {pendingAction === 'finder'
                ? 'Saving finder settings...'
                : isFindable
                ? 'Stop sharing my spot'
                : 'Help someone find me'}
            </button>
          </div>

          {resolvedActiveConnection ? (
            <div className="rt-connection-accepted mt-6 rounded-3xl border border-[var(--rt-border-strong)] bg-[var(--rt-accent-soft)] p-5">
              <div className="flex items-center justify-between gap-3 text-[var(--rt-accent)]">
                <div className="flex items-center gap-3">
                  <MessageCircle className="h-5 w-5" />
                  <p className="text-sm font-semibold">Current conversation</p>
                </div>
                {conversationElapsed ? (
                  <span className="rounded-full bg-white/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--rt-accent)]">
                    {conversationElapsed}
                  </span>
                ) : null}
              </div>
              <p className="mt-3 text-xl font-semibold text-[var(--rt-ink)]">
                {resolvedActiveConnection.counterpart.username}
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--rt-ink-soft)]">
                {resolvedActiveConnection.counterpart.moodEmoji}{' '}
                {resolvedActiveConnection.counterpart.intentSummary}
              </p>
              <p className="mt-3 text-sm leading-6 text-[var(--rt-accent)]/80">
                Take your time. Either person can end the conversation, and you will
                both return to ready automatically.
              </p>

              {/* Show the pre-conversation thread from the request */}
              {acceptedRequestThread &&
              (acceptedRequestThread.introMessage || acceptedRequestThread.messages.length > 0) ? (
                <div className="mt-4 rounded-2xl border border-[var(--rt-border)] bg-white/70 p-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--rt-ink-soft)]">
                    Before you met
                  </p>
                  {acceptedRequestThread.introMessage ? (
                    <div className="mb-2 flex justify-start">
                      <div className="max-w-[85%] rounded-2xl border border-[var(--rt-border)] bg-white px-4 py-2.5 text-sm leading-6 text-[var(--rt-ink)]">
                        {acceptedRequestThread.introMessage}
                      </div>
                    </div>
                  ) : null}
                  {acceptedRequestThread.messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`mb-2 flex ${msg.senderUserId === session.user.id ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-6 ${
                          msg.senderUserId === session.user.id
                            ? 'bg-[var(--rt-accent)] text-white'
                            : 'border border-[var(--rt-border)] bg-white text-[var(--rt-ink)]'
                        }`}
                      >
                        {msg.body}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={handleLeavePlace}
              disabled={pendingAction === 'leave'}
              className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--rt-border)] bg-white px-5 py-3 font-semibold text-[var(--rt-ink)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              <ArrowLeft className="h-4 w-4" />
              {pendingAction === 'leave' ? 'Leaving place...' : 'Switch place'}
            </button>
          </div>

          {error ? (
            <div className="rt-notice mt-4 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          ) : null}
        </section>
      </div>

      {/* Request to talk modal */}
      {connectModalTarget ? (
        <div className="rt-modal-backdrop fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center">
          <div className="rt-modal-sheet w-full max-w-xl rounded-t-[2rem] border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] p-6 shadow-[0_24px_80px_rgba(17,52,44,0.22)] sm:rounded-[2rem] sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-[0.24em] text-[var(--rt-accent)]">
                  Request to talk
                </p>
                <h3 className="mt-2 text-2xl font-bold text-[var(--rt-ink)]">
                  Send a short note
                </h3>
              </div>
              <button
                type="button"
                onClick={handleCloseConnectModal}
                className="rounded-full border border-[var(--rt-border)] p-2 text-[var(--rt-ink-soft)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.9] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[var(--rt-ink)]"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 rounded-3xl border border-[var(--rt-border)] bg-[var(--rt-accent-soft)] p-4">
              <p className="text-sm font-semibold text-[var(--rt-ink)]">
                {connectModalTarget.username}
              </p>
              <p className="mt-2 text-sm leading-6 text-[var(--rt-ink-soft)]">
                {connectModalTarget.moodEmoji} {connectModalTarget.intentSummary || 'Open to a nearby conversation.'}
              </p>
            </div>

            <div className="mt-5">
              <label>
                <span className="mb-2 block text-sm font-semibold text-[var(--rt-ink)]">
                  Your message <span className="font-normal text-[var(--rt-ink-soft)]">(optional)</span>
                </span>
                <p className="mb-3 text-sm leading-6 text-[var(--rt-ink-soft)]">
                  Keep it genuine. {connectModalTarget.username} will use this to decide whether to meet you.
                </p>
                <textarea
                  value={introMessage}
                  onChange={(e) => setIntroMessage(e.target.value)}
                  rows={3}
                  maxLength={240}
                  placeholder={`Hi, I noticed you're open to a conversation. I'd love to chat about...`}
                  className="w-full rounded-3xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-4 py-3 text-base text-[var(--rt-ink)] outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-[color:rgba(69,104,90,0.55)] focus:border-[var(--rt-accent-strong)] focus:ring-2 focus:ring-[var(--rt-accent-soft-strong)]"
                />
                <p className="mt-1 text-right text-xs text-[var(--rt-ink-soft)]">
                  {introMessage.length}/240
                </p>
              </label>
            </div>

            {connectError ? (
              <div className="rt-notice mt-4 flex items-start gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {connectError}
              </div>
            ) : null}

            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => void handleSendConnectRequest()}
                disabled={pendingAction === 'connect'}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--rt-accent)] px-5 py-3 font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
              >
                <Send className="h-4 w-4" />
                {pendingAction === 'connect' ? 'Sending...' : 'Request to talk'}
              </button>
              <button
                type="button"
                onClick={handleCloseConnectModal}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--rt-border)] bg-white px-5 py-3 font-semibold text-[var(--rt-ink)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

function MetricCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: ReactNode
  label: string
  value: string
  tone: 'amber' | 'emerald' | 'slate'
}) {
  const styles = {
    amber: 'border-[var(--rt-border)] bg-[var(--rt-accent-soft)] text-[var(--rt-accent)]',
    emerald: 'border-[var(--rt-border)] bg-[color:rgba(79,70,229,0.10)] text-[var(--rt-accent)]',
    slate: 'border-[var(--rt-border)] bg-white text-[var(--rt-ink)]',
  }[tone]

  return (
    <div className={`rounded-[2rem] border p-5 shadow-sm ${styles}`}>
      <div className="inline-flex rounded-2xl border border-current/10 bg-white/70 p-3">
        {icon}
      </div>
      <p className="mt-4 text-sm font-medium">{label}</p>
      <p key={value} className="rt-number-pop mt-2 text-4xl font-black tracking-[-0.04em]">{value}</p>
    </div>
  )
}

function MessageBubble({
  message,
  isSelf,
}: {
  message: ConnectRequestMessage
  isSelf: boolean
}) {
  return (
    <div className={`flex ${isSelf ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-6 ${
          isSelf
            ? 'bg-[var(--rt-accent)] text-white'
            : 'border border-[var(--rt-border)] bg-white text-[var(--rt-ink)]'
        }`}
      >
        {message.body}
      </div>
    </div>
  )
}

function IncomingRequestCard({
  request,
  currentUserId,
  isResponding,
  isSendingReply,
  replyDraft,
  replyError,
  onReplyDraftChange,
  onSendReply,
  onAccept,
  onReject,
}: {
  request: IncomingConnectRequest
  currentUserId: string
  isResponding: boolean
  isSendingReply: boolean
  replyDraft: string
  replyError: string | null
  onReplyDraftChange: (val: string) => void
  onSendReply: () => void
  onAccept: () => void
  onReject: () => void
}) {
  const recipientMessageCount = request.recipientMessageCount
  const canReply = recipientMessageCount < MAX_MESSAGES_PER_USER

  return (
    <div className="rounded-3xl border border-[var(--rt-border)] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-[var(--rt-ink)]">
            {request.requester.username}
          </p>
          <p className="mt-1 text-sm leading-6 text-[var(--rt-ink-soft)]">
            {request.requester.moodEmoji} {request.requester.intentSummary || 'Open to a nearby conversation.'}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-[var(--rt-accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--rt-accent)]">
          Request to talk
        </span>
      </div>

      {/* Intro message */}
      {request.introMessage ? (
        <div className="mt-3 rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-4 py-3">
          <p className="text-sm leading-6 text-[var(--rt-ink)]">
            "{request.introMessage}"
          </p>
        </div>
      ) : null}

      {/* Thread messages */}
      {request.messages.length > 0 ? (
        <div className="mt-3 space-y-2">
          {request.messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isSelf={msg.senderUserId === currentUserId}
            />
          ))}
        </div>
      ) : null}

      {/* Message counter */}
      <p className="mt-3 text-xs text-[var(--rt-ink-soft)]">
        {canReply
          ? `${recipientMessageCount} of ${MAX_MESSAGES_PER_USER} messages used`
          : `You've reached the ${MAX_MESSAGES_PER_USER}-message limit for this request.`}
      </p>

      {/* Reply box */}
      {canReply ? (
        <div className="mt-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={replyDraft}
              onChange={(e) => onReplyDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && replyDraft.trim()) {
                  e.preventDefault()
                  onSendReply()
                }
              }}
              maxLength={240}
              placeholder="Send a message…"
              disabled={isSendingReply}
              className="flex-1 rounded-2xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-3 py-2 text-sm text-[var(--rt-ink)] outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-[color:rgba(69,104,90,0.55)] focus:border-[var(--rt-accent-strong)] focus:ring-2 focus:ring-[var(--rt-accent-soft-strong)] disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              onClick={onSendReply}
              disabled={isSendingReply || !replyDraft.trim()}
              className="inline-flex items-center justify-center rounded-2xl bg-[var(--rt-accent)] px-3 py-2 text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)] disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
          {replyError ? (
            <p className="mt-2 text-xs text-rose-600">{replyError}</p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={onAccept}
          disabled={isResponding}
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[var(--rt-accent)] px-4 py-2.5 text-sm font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)] disabled:cursor-not-allowed disabled:opacity-70"
        >
          <Check className="h-4 w-4" />
          {isResponding ? 'Accepting...' : 'Accept and start talking'}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={isResponding}
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-[var(--rt-border)] bg-white px-4 py-2.5 text-sm font-semibold text-[var(--rt-ink)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)] disabled:cursor-not-allowed disabled:opacity-70"
        >
          <X className="h-4 w-4" />
          Decline
        </button>
      </div>
    </div>
  )
}

function PresencePersonCard({
  participant,
  isCurrentUser,
  isInConversation,
  staggerIndex = 0,
  onConnect,
  onPing,
  isPinging,
}: {
  participant: PlaceAgentState['participants'][number]
  isCurrentUser: boolean
  isInConversation: boolean
  staggerIndex?: number
  onConnect: (() => void) | null
  onPing: (() => void) | null
  isPinging: boolean
}) {
  return (
    <div
      className="rt-card-stagger rounded-3xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-4 py-4"
      style={{ animationDelay: `${staggerIndex * 50}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-[var(--rt-ink)]">
            {participant.username}
            {isCurrentUser ? (
              <span className="ml-2 rounded-full bg-[var(--rt-accent)] px-2 py-0.5 text-xs font-semibold uppercase tracking-[0.14em] text-white">
                You
              </span>
            ) : null}
          </p>
          <p className="mt-2 text-sm leading-6 text-[var(--rt-ink-soft)]">
            {participant.moodEmoji} {participant.intentSummary || 'Open to a nearby conversation.'}
          </p>
          {participant.isFindable && participant.locationHint ? (
            <p className="mt-2 text-sm font-medium text-[var(--rt-accent)]">
              Near {participant.locationHint.toLowerCase()}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="rounded-full bg-[var(--rt-accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--rt-accent)]">
            {participant.isFindable ? 'Findable' : 'Ready'}
          </span>
          {onConnect && !isCurrentUser ? (
            <button
              type="button"
              onClick={onConnect}
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--rt-accent)] px-3 py-1.5 text-xs font-semibold text-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] hover:bg-[var(--rt-accent-strong)]"
            >
              <Send className="h-3 w-3" />
              Request to talk
            </button>
          ) : null}
          {onPing ? (
            <button
              type="button"
              onClick={onPing}
              disabled={isPinging}
              className="inline-flex items-center gap-2 rounded-full border border-[var(--rt-border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--rt-ink)] transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)_and_(pointer:fine)]:hover:border-[var(--rt-border-strong)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <BellRing className={`h-3.5 w-3.5${isPinging ? ' rt-bell-ring' : ''}`} />
              {isPinging ? 'Pinging...' : 'Ping me'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function PresenceSummaryCard({
  label,
  count,
  description,
}: {
  label: string
  count: number
  description: string
}) {
  return (
    <div className="rounded-3xl border border-[var(--rt-border)] bg-[var(--rt-surface-strong)] px-4 py-4">
      <p className="text-sm font-semibold text-[var(--rt-ink)]">{label}</p>
      <p className="mt-2 text-3xl font-black tracking-[-0.04em] text-[var(--rt-ink)]">{count}</p>
      <p className="mt-2 text-sm leading-6 text-[var(--rt-ink-soft)]">{description}</p>
    </div>
  )
}

function formatConversationElapsed(createdAt: string | Date, now: number) {
  const startedAt = new Date(createdAt).getTime()
  if (!Number.isFinite(startedAt)) return null
  const elapsedMinutes = Math.max(0, Math.floor((now - startedAt) / 60000))
  if (elapsedMinutes < 1) return 'Started now'
  if (elapsedMinutes === 1) return '1 min in'
  return `${elapsedMinutes} min in`
}
