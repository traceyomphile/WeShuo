export interface AuthUser {
  id: number
  username: string
  date_of_birth?: string | null
  profile_media_id?: number | null
  time_format?: '12' | '24'
  created_at?: string
  last_seen?: string | null
}

export interface User extends AuthUser {
  online: boolean
}

export interface Group {
  id: number
  name: string
  description: string
  creator_id: number
  profile_media_id: number | null
  created_at: string
  member_count: number
  role: 'admin' | 'member'
}

export interface GroupMember extends User {
  role: 'admin' | 'member'
  membership_status: 'current' | 'past'
  joined_at: string
  left_at: string | null
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
  | { kind: 'direct'; id: number; name: string; online: boolean; lastSeen?: string | null; profileMediaId?: number | null }
  | {
      kind: 'group'
      id: number
      name: string
      description: string
      memberCount: number
      creatorId: number
      profileMediaId: number | null
      role: 'admin' | 'member'
    }

export type CallKind = 'audio' | 'video'

export interface SocketEvent {
  type: string
  from?: string
  data?: unknown
  detail?: string
}
