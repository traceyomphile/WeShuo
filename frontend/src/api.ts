import type { AuthUser, Group, GroupMember, Message, User } from './types'

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '')

export class ApiError extends Error {
  public status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')

  const response = await fetch(`${API_URL}${path}`, { ...options, headers })
  if (!response.ok) {
    let detail = `Request failed (${response.status})`
    try {
      const body = await response.json()
      detail = typeof body.detail === 'string' ? body.detail : detail
    } catch { /* response was not JSON */ }
    throw new ApiError(detail, response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export const api = {
  register: (username: string, password: string) => request<{ access_token: string; user: AuthUser }>('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ username, password }),
  }),
  login: (username: string, password: string) => request<{ access_token: string; user: AuthUser }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password }),
  }),
  me: (token: string) => request<AuthUser>('/api/auth/me', {}, token),
  updateAccount: (token: string, changes: { username?: string; date_of_birth?: string | null; profile_media_id?: number | null; time_format?: '12' | '24'; current_password?: string }) => request<{ access_token: string; user: AuthUser }>('/api/users/me', {
    method: 'PATCH', body: JSON.stringify(changes),
  }, token),
  changePassword: (token: string, currentPassword: string, newPassword: string) => request<void>('/api/users/me/password', {
    method: 'POST', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  }, token),
  users: (token: string, search = '') => request<User[]>(`/api/users?search=${encodeURIComponent(search)}`, {}, token),
  conversations: (token: string) => request<User[]>('/api/conversations', {}, token),
  groups: (token: string) => request<Group[]>('/api/groups', {}, token),
  createGroup: (token: string, name: string, members: string[]) => request<{ id: number }>('/api/groups', {
    method: 'POST', body: JSON.stringify({ name, members }),
  }, token),
  updateGroup: (token: string, groupId: number, changes: { name?: string; description?: string; profile_media_id?: number | null }) => request<Group>(`/api/groups/${groupId}`, {
    method: 'PATCH', body: JSON.stringify(changes),
  }, token),
  groupMembers: (token: string, groupId: number) => request<GroupMember[]>(`/api/groups/${groupId}/members`, {}, token),
  addGroupMember: (token: string, groupId: number, username: string) => request<{ group_id: number; username: string; member_count: number }>(`/api/groups/${groupId}/members`, {
    method: 'POST', body: JSON.stringify({ username }),
  }, token),
  removeGroupMember: (token: string, groupId: number, username: string) => request<{ group_id: number; username: string; member_count: number }>(`/api/groups/${groupId}/members/${encodeURIComponent(username)}`, {
    method: 'DELETE',
  }, token),
  setGroupAdmin: (token: string, groupId: number, username: string, isAdmin: boolean) => request<{ group_id: number; username: string; role: 'admin' | 'member' }>(`/api/groups/${groupId}/members/${encodeURIComponent(username)}/admin`, {
    method: 'PATCH', body: JSON.stringify({ is_admin: isAdmin }),
  }, token),
  directHistory: (token: string, username: string) => request<Message[]>(`/api/messages/direct/${encodeURIComponent(username)}`, {}, token),
  markDirectSeen: (token: string, username: string) => request<{ up_to_id: number | null; status: 'seen' }>(`/api/messages/direct/${encodeURIComponent(username)}/seen`, {
    method: 'POST',
  }, token),
  groupHistory: (token: string, groupId: number) => request<Message[]>(`/api/groups/${groupId}/messages`, {}, token),
  sendDirect: (token: string, recipient: string, content: string, mediaId?: number) => request<Message>('/api/messages/direct', {
    method: 'POST', body: JSON.stringify({ recipient, content, media_id: mediaId }),
  }, token),
  sendGroup: (token: string, groupId: number, content: string, mediaId?: number) => request<Message>(`/api/groups/${groupId}/messages`, {
    method: 'POST', body: JSON.stringify({ content, media_id: mediaId }),
  }, token),
  upload: (token: string, file: File) => {
    const data = new FormData()
    data.append('file', file)
    return request<{ id: number; filename: string }>('/api/media', { method: 'POST', body: data }, token)
  },
  download: async (token: string, mediaId: number) => {
    const response = await fetch(`${API_URL}/api/media/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new ApiError('Could not download the attachment.', response.status)
    const disposition = response.headers.get('content-disposition') ?? ''
    const encoded = disposition.match(/filename\*=utf-8''([^;]+)/i)?.[1]
    const basic = disposition.match(/filename="?([^";]+)"?/i)?.[1]
    return { blob: await response.blob(), filename: encoded ? decodeURIComponent(encoded) : basic ?? `attachment-${mediaId}` }
  },
}

export function socketUrl(token: string): string {
  const url = new URL(API_URL)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws'
  url.search = new URLSearchParams({ token }).toString()
  return url.toString()
}
