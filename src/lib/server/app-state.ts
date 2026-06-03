import { and, asc, count, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { getAgentByName } from 'agents'
import { getRequestHeaders } from '@tanstack/react-start/server'
import type {
  ActiveConnectionState,
  ActiveConnectionThread,
  AppSession,
  AppState,
  ConnectRequestMessage,
  CurrentPlaceState,
  IncomingConnectRequest,
  NearbyPlace,
  NearbyPlacePreviewState,
  PresenceStatus,
  UserAgentState,
  UserProfileState,
} from '../app-types'
import { auth } from './auth'
import { db } from './db'
import type { UserAgent } from './agents/user-agent'
import {
  connectRequest,
  connectRequestMessage,
  handoffConnection,
  place,
  user,
  userProfile,
} from './db/schema'
import { getUserAgentBinding } from './env'

/** Requests expire after this many milliseconds (10 minutes). */
const REQUEST_TTL_MS = 10 * 60 * 1000

/** Maximum messages each participant may send per request. */
const MAX_MESSAGES_PER_USER = 3

/** Maximum character length for a single message body. */
const MAX_MESSAGE_BODY_LENGTH = 240

type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>

type OverpassElement = {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

function mapSession(session: NonNullable<SessionResult>): AppSession {
  return {
    session: {
      expiresAt: session.session.expiresAt,
    },
    user: {
      id: session.user.id,
      name: session.user.name,
      username: session.user.username ?? null,
      displayUsername: session.user.displayUsername ?? null,
    },
  }
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

function mapUserProfile(
  profileRecord: typeof userProfile.$inferSelect,
): UserProfileState {
  return {
    userId: profileRecord.userId,
    moodEmoji: profileRecord.moodEmoji,
    intentText: profileRecord.intentText,
    intentSummary: profileRecord.intentSummary,
    status: profileRecord.status as PresenceStatus,
    currentPlaceId: profileRecord.currentPlaceId,
    isFindable: profileRecord.isFindable,
    locationHint: profileRecord.locationHint,
    tags: parseTags(profileRecord.tags),
    pingRequestedAt: profileRecord.pingRequestedAt,
    pingRequestedByUserId: profileRecord.pingRequestedByUserId,
    pingRequestedByUsername: profileRecord.pingRequestedByUsername,
    createdAt: profileRecord.createdAt,
    updatedAt: profileRecord.updatedAt,
  }
}

function mapPlace(
  record: typeof place.$inferSelect,
  readyCount = 0,
): NearbyPlace {
  return {
    placeId: record.placeId,
    name: record.name,
    address: record.address,
    lat: record.lat,
    lng: record.lng,
    readyCount,
  }
}

function getDisplayUsername(record: typeof user.$inferSelect) {
  return record.displayUsername || record.username || record.name
}

async function getPendingIncomingRequests(
  recipientUserId: string,
  placeId: string,
): Promise<IncomingConnectRequest[]> {
  const now = new Date()

  // Expire any overdue pending requests before fetching.
  await db
    .update(connectRequest)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(connectRequest.status, 'pending'),
        sql`${connectRequest.expiresAt} < ${now.getTime()}`,
      ),
    )

  const rows = await db
    .select({
      id: connectRequest.id,
      placeId: connectRequest.placeId,
      introMessage: connectRequest.introMessage,
      expiresAt: connectRequest.expiresAt,
      createdAt: connectRequest.createdAt,
      requesterUserId: connectRequest.requesterUserId,
      requesterDisplayUsername: user.displayUsername,
      requesterUsername: user.username,
      requesterName: user.name,
      requesterMoodEmoji: userProfile.moodEmoji,
      requesterIntentSummary: userProfile.intentSummary,
    })
    .from(connectRequest)
    .innerJoin(user, eq(user.id, connectRequest.requesterUserId))
    .leftJoin(userProfile, eq(userProfile.userId, connectRequest.requesterUserId))
    .where(
      and(
        eq(connectRequest.recipientUserId, recipientUserId),
        eq(connectRequest.placeId, placeId),
        eq(connectRequest.status, 'pending'),
      ),
    )
    .orderBy(desc(connectRequest.createdAt))
    .limit(10)

  if (rows.length === 0) return []

  const requestIds = rows.map((r) => r.id)

  const messageRows = await db
    .select()
    .from(connectRequestMessage)
    .where(inArray(connectRequestMessage.requestId, requestIds))
    .orderBy(asc(connectRequestMessage.createdAt))

  return rows.map((row) => {
    const threadMessages = messageRows.filter((m) => m.requestId === row.id)

    const requesterMessageCount =
      (row.introMessage ? 1 : 0) +
      threadMessages.filter((m) => m.senderUserId === row.requesterUserId).length

    const recipientMessageCount = threadMessages.filter(
      (m) => m.senderUserId === recipientUserId,
    ).length

    const messages: ConnectRequestMessage[] = threadMessages.map((m) => ({
      id: m.id,
      senderUserId: m.senderUserId,
      body: m.body,
      createdAt: m.createdAt,
    }))

    return {
      id: row.id,
      placeId: row.placeId,
      introMessage: row.introMessage,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      messages,
      requesterMessageCount,
      recipientMessageCount,
      requester: {
        userId: row.requesterUserId,
        username:
          row.requesterDisplayUsername ||
          row.requesterUsername ||
          row.requesterName,
        moodEmoji: row.requesterMoodEmoji ?? null,
        intentSummary: row.requesterIntentSummary ?? null,
      },
    }
  })
}

async function getActiveConnectionForUser(
  userId: string,
): Promise<ActiveConnectionState | null> {
  const [connectionRecord] = await db
    .select()
    .from(handoffConnection)
    .where(
      and(
        eq(handoffConnection.status, 'accepted'),
        or(
          eq(handoffConnection.requesterUserId, userId),
          eq(handoffConnection.recipientUserId, userId),
        ),
      ),
    )
    .orderBy(desc(handoffConnection.createdAt))
    .limit(1)

  if (!connectionRecord) {
    return null
  }

  const counterpartUserId =
    connectionRecord.requesterUserId === userId
      ? connectionRecord.recipientUserId
      : connectionRecord.requesterUserId

  const [counterpartUser] = await db
    .select()
    .from(user)
    .where(eq(user.id, counterpartUserId))
    .limit(1)
  const [counterpartProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, counterpartUserId))
    .limit(1)

  if (!counterpartUser || !counterpartProfile) {
    return null
  }

  return {
    id: connectionRecord.id,
    placeId: connectionRecord.placeId,
    createdAt: connectionRecord.createdAt,
    counterpart: {
      userId: counterpartUser.id,
      username: getDisplayUsername(counterpartUser),
      moodEmoji: counterpartProfile.moodEmoji,
      intentSummary: counterpartProfile.intentSummary,
    },
  }
}

/**
 * Returns the chat thread for the currently-accepted connect request between
 * two users at a given place. Called when both users are in_conversation so
 * the chat UI can keep showing new messages after acceptance.
 */
async function getActiveConnectionThread(
  userId: string,
  counterpartUserId: string,
  placeId: string,
): Promise<ActiveConnectionThread | null> {
  // The accepted connectRequest is matched by participants + place (most recent first).
  const [requestRecord] = await db
    .select()
    .from(connectRequest)
    .where(
      and(
        eq(connectRequest.status, 'accepted'),
        eq(connectRequest.placeId, placeId),
        or(
          and(
            eq(connectRequest.requesterUserId, userId),
            eq(connectRequest.recipientUserId, counterpartUserId),
          ),
          and(
            eq(connectRequest.requesterUserId, counterpartUserId),
            eq(connectRequest.recipientUserId, userId),
          ),
        ),
      ),
    )
    .orderBy(desc(connectRequest.createdAt))
    .limit(1)

  if (!requestRecord) return null

  const messageRows = await db
    .select()
    .from(connectRequestMessage)
    .where(eq(connectRequestMessage.requestId, requestRecord.id))
    .orderBy(asc(connectRequestMessage.createdAt))

  const messages: ConnectRequestMessage[] = messageRows.map((m) => ({
    id: m.id,
    senderUserId: m.senderUserId,
    body: m.body,
    createdAt: m.createdAt,
  }))

  const myMessageCount =
    (requestRecord.requesterUserId === userId && requestRecord.introMessage ? 1 : 0) +
    messageRows.filter((m) => m.senderUserId === userId).length

  const theirMessageCount =
    (requestRecord.requesterUserId === counterpartUserId && requestRecord.introMessage
      ? 1
      : 0) + messageRows.filter((m) => m.senderUserId === counterpartUserId).length

  return {
    requestId: requestRecord.id,
    introMessage: requestRecord.introMessage,
    messages,
    myMessageCount,
    theirMessageCount,
  }
}

function mapUserProfileStateFromAgent(
  state: UserAgentState,
  intentText: string | null,
): UserProfileState {
  const now = state.updatedAt ? new Date(state.updatedAt) : new Date()

  return {
    userId: state.userId,
    moodEmoji: state.moodEmoji,
    intentText,
    intentSummary: state.intentSummary,
    status: state.status,
    currentPlaceId: state.currentPlaceId,
    isFindable: state.isFindable,
    locationHint: state.locationHint,
    tags: state.tags ?? [],
    pingRequestedAt: state.pingRequestedAt,
    pingRequestedByUserId: state.pingRequestedByUserId,
    pingRequestedByUsername: state.pingRequestedByUsername,
    createdAt: now,
    updatedAt: now,
  }
}

export async function getCurrentSession() {
  try {
    return await auth.api.getSession({
      headers: new Headers(getRequestHeaders()),
      asResponse: false,
      query: {
        disableRefresh: true,
      },
    })
  } catch {
    return null
  }
}

export async function requireCurrentSession() {
  const session = await getCurrentSession()

  if (!session) {
    throw new Error('Your session expired. Sign in again and try once more.')
  }

  return session
}

export async function getAppState(): Promise<AppState> {
  const session = await getCurrentSession()

  if (!session) {
    return {
      session: null,
      profile: null,
      currentPlace: null,
      pendingIncomingRequests: [],
      activeConnection: null,
    }
  }

  const [profileRecord] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, session.user.id))
    .limit(1)

  let currentPlace: CurrentPlaceState | null = null
  let pendingIncomingRequests: IncomingConnectRequest[] = []

  if (profileRecord?.currentPlaceId) {
    const [currentPlaceRecord] = await db
      .select()
      .from(place)
      .where(eq(place.placeId, profileRecord.currentPlaceId))
      .limit(1)

    if (currentPlaceRecord) {
      const [{ readyCount }] = await db
        .select({
          readyCount: sql<number>`count(*)`,
        })
        .from(userProfile)
        .where(
          and(
            eq(userProfile.currentPlaceId, profileRecord.currentPlaceId),
            eq(userProfile.status, 'ready'),
          ),
        )

      currentPlace = {
        place: mapPlace(currentPlaceRecord, readyCount),
        readyCount,
      }

      pendingIncomingRequests = await getPendingIncomingRequests(
        session.user.id,
        profileRecord.currentPlaceId,
      )
    }
  }

  const activeConnection = await getActiveConnectionForUser(session.user.id)

  const activeConnectionThread =
    activeConnection
      ? await getActiveConnectionThread(
          session.user.id,
          activeConnection.counterpart.userId,
          activeConnection.placeId,
        )
      : null

  return {
    session: mapSession(session),
    profile: profileRecord ? mapUserProfile(profileRecord) : null,
    currentPlace,
    pendingIncomingRequests,
    activeConnection,
    activeConnectionThread,
  }
}

async function getUserAgent(userId: string) {
  return getAgentByName<Cloudflare.Env, UserAgent>(getUserAgentBinding(), userId)
}

export async function saveUserProfile(input: {
  moodEmoji: string
  intentText: string
  currentPlaceId: string
  tags?: string[]
}) {
  const session = await requireCurrentSession()
  const agent = await getUserAgent(session.user.id)
  const nextState = await agent.setProfile(input)
  const intentText = input.intentText.replace(/\s+/g, ' ').trim() || null

  return mapUserProfileStateFromAgent(nextState, intentText)
}

export async function setReadyState(input: { ready: boolean }) {
  const session = await requireCurrentSession()
  const agent = await getUserAgent(session.user.id)
  await agent.setReady(input)
}

export async function saveFinderProfile(input: {
  isFindable: boolean
  locationHint: string | null
}) {
  const session = await requireCurrentSession()
  const agent = await getUserAgent(session.user.id)
  const [existingProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, session.user.id))
    .limit(1)
  const nextState = await agent.setFinderProfile(input)

  return mapUserProfileStateFromAgent(nextState, existingProfile?.intentText ?? null)
}

export async function pingFindableUser(input: { userId: string }) {
  const session = await requireCurrentSession()
  const targetUserId = input.userId.trim()

  if (!targetUserId) {
    throw new Error('Choose someone in the place first.')
  }

  const targetAgent = await getUserAgent(targetUserId)
  await targetAgent.requestFinderPing({
    requesterUserId: session.user.id,
  })

  return {
    success: true,
  }
}

export async function leaveCurrentPlace() {
  const session = await requireCurrentSession()
  const agent = await getUserAgent(session.user.id)
  await agent.leavePlace()
}

export async function sendConnectRequest(input: {
  recipientUserId: string
  introMessage: string
}) {
  const session = await requireCurrentSession()
  const recipientUserId = input.recipientUserId.trim()
  const introMessage = input.introMessage.replace(/\s+/g, ' ').trim() || null

  if (!recipientUserId) {
    throw new Error('Choose someone to connect with.')
  }

  if (recipientUserId === session.user.id) {
    throw new Error('You cannot send a request to yourself.')
  }

  if (introMessage && introMessage.length > MAX_MESSAGE_BODY_LENGTH) {
    throw new Error(`Keep your message under ${MAX_MESSAGE_BODY_LENGTH} characters.`)
  }

  const [viewerProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, session.user.id))
    .limit(1)

  if (!viewerProfile?.currentPlaceId) {
    throw new Error('Join a place before sending a connect request.')
  }

  if (viewerProfile.status === 'in_conversation') {
    throw new Error('End your current conversation before sending a new request.')
  }

  const [recipientProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, recipientUserId))
    .limit(1)

  if (
    !recipientProfile?.currentPlaceId ||
    recipientProfile.currentPlaceId !== viewerProfile.currentPlaceId
  ) {
    throw new Error('That person is no longer at this place.')
  }

  if (recipientProfile.status !== 'ready') {
    throw new Error('That person is not marked ready right now.')
  }

  // Cancel any existing pending request from this requester to this recipient at this place.
  const now = new Date()
  await db
    .update(connectRequest)
    .set({ status: 'cancelled', updatedAt: now })
    .where(
      and(
        eq(connectRequest.requesterUserId, session.user.id),
        eq(connectRequest.recipientUserId, recipientUserId),
        eq(connectRequest.placeId, viewerProfile.currentPlaceId),
        eq(connectRequest.status, 'pending'),
      ),
    )

  const requestId = crypto.randomUUID()
  const expiresAt = new Date(now.getTime() + REQUEST_TTL_MS)

  await db.insert(connectRequest).values({
    id: requestId,
    requesterUserId: session.user.id,
    recipientUserId,
    placeId: viewerProfile.currentPlaceId,
    introMessage,
    status: 'pending',
    expiresAt,
    createdAt: now,
    updatedAt: now,
  })

  return { success: true, requestId }
}

export async function addMessageToRequest(input: {
  requestId: string
  body: string
}) {
  const session = await requireCurrentSession()
  const requestId = input.requestId.trim()
  const body = input.body.replace(/\s+/g, ' ').trim()

  if (!requestId) {
    throw new Error('No request specified.')
  }

  if (!body) {
    throw new Error('Message cannot be empty.')
  }

  if (body.length > MAX_MESSAGE_BODY_LENGTH) {
    throw new Error(`Keep your message under ${MAX_MESSAGE_BODY_LENGTH} characters.`)
  }

  const [requestRecord] = await db
    .select()
    .from(connectRequest)
    .where(eq(connectRequest.id, requestId))
    .limit(1)

  if (!requestRecord) {
    throw new Error('That request no longer exists.')
  }

  // Only the requester and recipient may send messages on this request.
  const isParticipant =
    requestRecord.requesterUserId === session.user.id ||
    requestRecord.recipientUserId === session.user.id

  if (!isParticipant) {
    throw new Error('You cannot message on this request.')
  }

  // Allow messaging on pending requests (pre-acceptance) and accepted requests
  // (post-acceptance chat). All other statuses mean the conversation is over.
  if (requestRecord.status !== 'pending' && requestRecord.status !== 'accepted') {
    throw new Error('This conversation is no longer active.')
  }

  // Expiry only applies to pending requests that haven't been acted on yet.
  if (
    requestRecord.status === 'pending' &&
    requestRecord.expiresAt.getTime() < Date.now()
  ) {
    await db
      .update(connectRequest)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(connectRequest.id, requestId))
    throw new Error('That request has expired.')
  }

  // Count existing messages from this sender. The requester's introMessage counts as 1.
  const isRequester = requestRecord.requesterUserId === session.user.id
  const introMessageCount = isRequester && requestRecord.introMessage ? 1 : 0

  const [{ threadCount }] = await db
    .select({ threadCount: count() })
    .from(connectRequestMessage)
    .where(
      and(
        eq(connectRequestMessage.requestId, requestId),
        eq(connectRequestMessage.senderUserId, session.user.id),
      ),
    )

  const totalSent = introMessageCount + (threadCount ?? 0)

  if (totalSent >= MAX_MESSAGES_PER_USER) {
    throw new Error(
      `You've reached the ${MAX_MESSAGES_PER_USER}-message limit for this request.`,
    )
  }

  const now = new Date()
  const messageId = crypto.randomUUID()

  await db.insert(connectRequestMessage).values({
    id: messageId,
    requestId,
    senderUserId: session.user.id,
    body,
    createdAt: now,
  })

  return { success: true, messageId }
}

export async function respondToConnectRequest(input: {
  requestId: string
  accept: boolean
}) {
  const session = await requireCurrentSession()
  const requestId = input.requestId.trim()

  if (!requestId) {
    throw new Error('No request specified.')
  }

  const [requestRecord] = await db
    .select()
    .from(connectRequest)
    .where(eq(connectRequest.id, requestId))
    .limit(1)

  if (!requestRecord) {
    throw new Error('That request no longer exists.')
  }

  if (requestRecord.recipientUserId !== session.user.id) {
    throw new Error('You cannot respond to this request.')
  }

  if (requestRecord.status !== 'pending') {
    throw new Error('That request is no longer pending.')
  }

  // Check expiry.
  const now = new Date()
  if (requestRecord.expiresAt.getTime() < now.getTime()) {
    await db
      .update(connectRequest)
      .set({ status: 'expired', updatedAt: now })
      .where(eq(connectRequest.id, requestId))
    throw new Error('That request has expired.')
  }

  if (!input.accept) {
    await db
      .update(connectRequest)
      .set({ status: 'rejected', updatedAt: now })
      .where(eq(connectRequest.id, requestId))

    return { success: true, accepted: false }
  }

  // Accepting: validate both users are still ready in the same place.
  const [recipientProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, session.user.id))
    .limit(1)

  const [requesterProfile] = await db
    .select()
    .from(userProfile)
    .where(eq(userProfile.userId, requestRecord.requesterUserId))
    .limit(1)

  if (
    !recipientProfile?.currentPlaceId ||
    recipientProfile.currentPlaceId !== requestRecord.placeId
  ) {
    throw new Error('You are no longer at the same place.')
  }

  if (recipientProfile.status === 'in_conversation') {
    throw new Error('End your current conversation before accepting a request.')
  }

  if (
    !requesterProfile?.currentPlaceId ||
    requesterProfile.currentPlaceId !== requestRecord.placeId
  ) {
    await db
      .update(connectRequest)
      .set({ status: 'cancelled', updatedAt: now })
      .where(eq(connectRequest.id, requestId))

    throw new Error('That person has left the place. The request was cancelled.')
  }

  if (requesterProfile.status === 'in_conversation') {
    await db
      .update(connectRequest)
      .set({ status: 'cancelled', updatedAt: now })
      .where(eq(connectRequest.id, requestId))

    throw new Error('That person is already in a conversation.')
  }

  const existingRecipientConnection = await getActiveConnectionForUser(session.user.id)
  if (existingRecipientConnection) {
    throw new Error('You are already connected with someone.')
  }

  const existingRequesterConnection = await getActiveConnectionForUser(
    requestRecord.requesterUserId,
  )
  if (existingRequesterConnection) {
    throw new Error('That person is already in a conversation.')
  }

  // Mark request accepted and create the active connection.
  await db
    .update(connectRequest)
    .set({ status: 'accepted', updatedAt: now })
    .where(eq(connectRequest.id, requestId))

  const agent = await getUserAgent(session.user.id)
  const result = await agent.connectWithUser({
    counterpartUserId: requestRecord.requesterUserId,
    placeId: requestRecord.placeId,
  })

  return { success: result.success, accepted: true, connectionId: result.connectionId }
}

export async function endCurrentConnection() {
  const session = await requireCurrentSession()
  const agent = await getUserAgent(session.user.id)
  const result = await agent.endCurrentConnection()

  return {
    success: result.success,
  }
}

function mapOverpassElement(el: OverpassElement): NearbyPlace | null {
  const tags = el.tags ?? {}
  const name = tags['name']
  if (!name) return null

  const lat = el.lat ?? el.center?.lat
  const lng = el.lon ?? el.center?.lon
  if (typeof lat !== 'number' || typeof lng !== 'number') return null

  const addrParts = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city']].filter(Boolean)
  const address = addrParts.length > 0 ? addrParts.join(' ') : name

  return {
    placeId: `osm:${el.type}:${el.id}`,
    name,
    address,
    lat,
    lng,
    readyCount: 0,
  }
}

export async function searchNearbyPlacesForLocation(input: {
  latitude: number
  longitude: number
}) {
  await requireCurrentSession()

  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
    throw new Error('A valid location is required.')
  }

  const query = `[out:json][timeout:10];(node["name"](around:120,${input.latitude},${input.longitude});way["name"](around:120,${input.latitude},${input.longitude}););out center 8;`

  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'TalkToMe/1.0',
    },
    body: `data=${encodeURIComponent(query)}`,
  })

  if (!response.ok) {
    throw new Error('Unable to load nearby places right now.')
  }

  const payload = (await response.json()) as {
    elements?: OverpassElement[]
  }

  const places = (payload.elements ?? [])
    .map(mapOverpassElement)
    .filter((value): value is NearbyPlace => value !== null)

  if (places.length > 0) {
    const now = new Date()

    await db
      .insert(place)
      .values(
        places.map((nearbyPlace) => ({
          placeId: nearbyPlace.placeId,
          name: nearbyPlace.name,
          address: nearbyPlace.address,
          lat: nearbyPlace.lat,
          lng: nearbyPlace.lng,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
  }

  if (places.length === 0) {
    return places
  }

  const readyCountRows = await db
    .select({
      placeId: userProfile.currentPlaceId,
      readyCount: sql<number>`count(*)`,
    })
    .from(userProfile)
    .where(
      and(
        inArray(
          userProfile.currentPlaceId,
          places.map((nearbyPlace) => nearbyPlace.placeId),
        ),
        eq(userProfile.status, 'ready'),
      ),
    )
    .groupBy(userProfile.currentPlaceId)

  const readyCountByPlaceId = new Map(
    readyCountRows
      .filter(
        (
          row,
        ): row is {
          placeId: string
          readyCount: number
        } => Boolean(row.placeId),
      )
      .map((row) => [row.placeId, row.readyCount]),
  )

  return places.map((nearbyPlace) => ({
    ...nearbyPlace,
    readyCount: readyCountByPlaceId.get(nearbyPlace.placeId) ?? 0,
  }))
}

export async function getNearbyPlacePreview(input: { placeId: string }) {
  await requireCurrentSession()

  const placeId = input.placeId.trim()

  if (!placeId) {
    throw new Error('Choose a place first.')
  }

  const [placeRecord] = await db
    .select()
    .from(place)
    .where(eq(place.placeId, placeId))
    .limit(1)

  if (!placeRecord) {
    throw new Error('That place is no longer available.')
  }

  const presentStatuses = ['present', 'ready', 'in_conversation'] as const
  const [{ readyCount, checkedInCount }] = await db
    .select({
      readyCount: sql<number>`count(case when ${userProfile.status} = 'ready' then 1 end)`,
      checkedInCount: sql<number>`count(*)`,
    })
    .from(userProfile)
    .where(
      and(
        eq(userProfile.currentPlaceId, placeId),
        inArray(userProfile.status, presentStatuses),
      ),
    )

  const readyParticipantRecords = await db
    .select({
      userId: user.id,
      username: user.displayUsername,
      fallbackUsername: user.username,
      fallbackName: user.name,
      moodEmoji: userProfile.moodEmoji,
      intentSummary: userProfile.intentSummary,
      status: userProfile.status,
      isFindable: userProfile.isFindable,
      locationHint: userProfile.locationHint,
      pingRequestedAt: userProfile.pingRequestedAt,
      pingRequestedByUserId: userProfile.pingRequestedByUserId,
      pingRequestedByUsername: userProfile.pingRequestedByUsername,
    })
    .from(userProfile)
    .innerJoin(user, eq(user.id, userProfile.userId))
    .where(
      and(
        eq(userProfile.currentPlaceId, placeId),
        eq(userProfile.status, 'ready'),
      ),
    )
    .orderBy(desc(userProfile.updatedAt))
    .limit(8)

  const [{ activeConversationCount }] = await db
    .select({
      activeConversationCount: sql<number>`count(*)`,
    })
    .from(handoffConnection)
    .where(
      and(
        eq(handoffConnection.placeId, placeId),
        eq(handoffConnection.status, 'accepted'),
      ),
    )

  return {
    placeId,
    readyCount,
    checkedInCount,
    activeConversationCount,
    readyParticipants: readyParticipantRecords.map((record) => ({
      userId: record.userId,
      username:
        record.username || record.fallbackUsername || record.fallbackName,
      moodEmoji: record.moodEmoji,
      intentSummary: record.intentSummary,
      status: record.status as NearbyPlacePreviewState['readyParticipants'][number]['status'],
      isFindable: record.isFindable ?? false,
      locationHint: record.locationHint ?? null,
      pingRequestedAt: record.pingRequestedAt,
      pingRequestedByUserId: record.pingRequestedByUserId ?? null,
      pingRequestedByUsername: record.pingRequestedByUsername ?? null,
    })),
  } satisfies NearbyPlacePreviewState
}
