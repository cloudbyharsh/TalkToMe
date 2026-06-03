export type AppSession = {
  session: {
    expiresAt: string | Date
  }
  user: {
    id: string
    name: string
    username?: string | null
    displayUsername?: string | null
  }
}

export type PresenceStatus =
  | 'offline'
  | 'present'
  | 'ready'
  | 'in_conversation'

export type UserProfileState = {
  userId: string
  moodEmoji: string | null
  intentText: string | null
  intentSummary: string | null
  status: PresenceStatus
  currentPlaceId: string | null
  isFindable: boolean
  locationHint: string | null
  pingRequestedAt: string | Date | null
  pingRequestedByUserId: string | null
  pingRequestedByUsername: string | null
  createdAt: string | Date
  updatedAt: string | Date
}

export type UserAgentState = {
  userId: string
  username: string | null
  moodEmoji: string | null
  intentSummary: string | null
  status: PresenceStatus
  currentPlaceId: string | null
  isFindable: boolean
  locationHint: string | null
  pingRequestedAt: string | null
  pingRequestedByUserId: string | null
  pingRequestedByUsername: string | null
  activeConversationId: string | null
  updatedAt: string | null
}

export type NearbyPlace = {
  placeId: string
  name: string
  address: string
  lat: number
  lng: number
  readyCount: number
}

// Live chat thread attached to an active (accepted) connection.
export type ActiveConnectionThread = {
  requestId: string
  introMessage: string | null
  messages: ConnectRequestMessage[]
  /** Messages sent by the current user (introMessage counts if they were requester). */
  myMessageCount: number
  /** Messages sent by the counterpart. */
  theirMessageCount: number
}

export type AppState = {
  session: AppSession | null
  profile: UserProfileState | null
  currentPlace: CurrentPlaceState | null
  pendingIncomingRequests: IncomingConnectRequest[]
  activeConnection: ActiveConnectionState | null
  /** Chat thread for the current active connection, if any. Live-refreshed via getAppState(). */
  activeConnectionThread: ActiveConnectionThread | null
}

export type CurrentPlaceState = {
  place: NearbyPlace
  readyCount: number
}

export type NearbyPlacePreviewState = {
  placeId: string
  readyCount: number
  checkedInCount: number
  activeConversationCount: number
  readyParticipants: PlaceAgentParticipantState[]
}

export type PlaceAgentState = {
  placeId: string
  readyCount: number
  checkedInCount: number
  participants: PlaceAgentParticipantState[]
  connections: PlaceAgentConnectionState[]
  updatedAt: string | null
}

export type PlaceAgentParticipantState = {
  userId: string
  username: string
  moodEmoji: string | null
  intentSummary: string | null
  status: PresenceStatus
  isFindable: boolean
  locationHint: string | null
  pingRequestedAt: string | Date | null
  pingRequestedByUserId: string | null
  pingRequestedByUsername: string | null
}

export type PlaceAgentConnectionState = {
  id: string
  requesterUserId: string
  recipientUserId: string
  createdAt: string | Date
}

export type ActiveConnectionState = {
  id: string
  placeId: string
  createdAt: string | Date
  counterpart: {
    userId: string
    username: string
    moodEmoji: string | null
    intentSummary: string | null
  }
}

// A single message within a pending connect request.
export type ConnectRequestMessage = {
  id: string
  senderUserId: string
  body: string
  createdAt: string | Date
}

// Connect request types (replace QR scan as the primary connection mechanism)
export type ConnectRequestStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired'

export type IncomingConnectRequest = {
  id: string
  placeId: string
  introMessage: string | null
  expiresAt: string | Date
  createdAt: string | Date
  messages: ConnectRequestMessage[]
  /** Total messages sent by the requester (introMessage + thread messages). */
  requesterMessageCount: number
  /** Total messages sent by the recipient in the thread. */
  recipientMessageCount: number
  requester: {
    userId: string
    username: string
    moodEmoji: string | null
    intentSummary: string | null
  }
}

// QrHandoffState and ConnectionPreviewState kept for backwards compatibility
// during migration but are no longer returned by getAppState.
export type QrHandoffState = {
  token: string
  url: string
  expiresAt: string | Date
  isActive: boolean
}

export type ConnectionPreviewState = {
  token: string
  placeId: string
  placeName: string
  counterpart: {
    userId: string
    username: string
    moodEmoji: string | null
    intentSummary: string | null
    status: PresenceStatus
  }
}
