export interface AuthUser {
  id: number
  username: string
  created_at?: string
  last_seen?: string | null
}

export interface User extends AuthUser {
  online: boolean
}

export interface Group {
  id: number
  name: string
  creator_id: number
  created_at: string
  member_count: number
}

export interface Message {
  id: number
  sender: string
  recipient: string | null
  group_id: number | null
  content: string
  media_id: number | null
  is_system: boolean
  created_at: string
  delivery_status: 'sent' | 'delivered' | 'seen'
}

export interface MessageReceipt {
  peer: string
  up_to_id: number
  status: 'delivered' | 'seen'
}

export type ChatTarget =
  | { kind: 'direct'; id: number; name: string; online: boolean; lastSeen?: string | null }
  | { kind: 'group'; id: number; name: string; memberCount: number }

export type CallKind = 'audio' | 'video'

export interface SocketEvent {
  type: string
  from?: string
  data?: unknown
  detail?: string
}
