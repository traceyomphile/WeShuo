import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, SubmitEvent } from 'react'
import {
  ArrowDownToLine, ArrowLeft, Camera, Check, CheckCheck, Clock3, Crown, Eye, EyeOff, Hash, KeyRound, LogOut, Menu, MessageCircleMore,
  Mic, MoreVertical, Paperclip, Phone, Plus, Search, Send, Shield, ShieldOff, Smile, Square, UserMinus, UserPlus, UsersRound, Video, X,
} from 'lucide-react'
import { api, socketUrl } from '../api'
import { errorMessage } from '../utils/errors'
import { useWebRTC } from '../hooks/useWebRTC'
import type { AuthUser, ChatTarget, Group, GroupMember, Message, MessageReceipt, SocketEvent, User } from '../types'
import CallOverlay from './CallOverlay'

interface Props { token: string; currentUser: AuthUser; onLogout: () => void; onSessionUpdated: (token: string, user: AuthUser) => void }
type GroupTarget = Extract<ChatTarget, { kind: 'group' }>

function avatar(name: string) { return name.slice(0, 2).toUpperCase() }
function chatKey(chat: ChatTarget) { return `${chat.kind}:${chat.id}` }
function groupTarget(group: Group): GroupTarget {
  return {
    kind: 'group',
    id: group.id,
    name: group.name,
    description: group.description,
    memberCount: group.member_count,
    creatorId: group.creator_id,
    profileMediaId: group.profile_media_id,
    role: group.role,
  }
}
const VOICE_NOTE_CONTENT = '🎤 Voice note'
const RECEIPT_RANK = { sent: 0, delivered: 1, seen: 2 } as const
function displayTime(value: string, timeFormat: '12' | '24') {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12' })
}

function calendarDay(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function displayMessageDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return ''

  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (calendarDay(value) === calendarDay(today.toISOString())) return 'Today'
  if (calendarDay(value) === calendarDay(yesterday.toISOString())) return 'Yesterday'
  return date.toLocaleDateString([], {
    day: 'numeric',
    month: 'long',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  })
}

export default function ChatApp({ token, currentUser, onLogout, onSessionUpdated }: Props) {
  const [conversations, setConversations] = useState<User[]>([])
  const [searchResults, setSearchResults] = useState<User[]>([])
  const [groupCandidates, setGroupCandidates] = useState<User[]>([])
  const [searching, setSearching] = useState(false)
  const [groups, setGroups] = useState<Group[]>([])
  const [selected, setSelected] = useState<ChatTarget | null>(null)
  const selectedRef = useRef<ChatTarget | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [search, setSearch] = useState('')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [loadingChat, setLoadingChat] = useState(false)
  const [sending, setSending] = useState(false)
  const [socketOnline, setSocketOnline] = useState(false)
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [showMobileSidebar, setShowMobileSidebar] = useState(true)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showGroupModal, setShowGroupModal] = useState(false)
  const [manageGroup, setManageGroup] = useState<GroupTarget | null>(null)
  const [showAccountSettings, setShowAccountSettings] = useState(false)
  const [toast, setToast] = useState('')
  const socketRef = useRef<WebSocket | null>(null)
  const usersRef = useRef<User[]>([])
  const messageAreaRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingTimerRef = useRef<number | null>(null)
  const signalHandler = useRef<(event: SocketEvent) => void>(() => {})

  useEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { usersRef.current = groupCandidates }, [groupCandidates])
  useEffect(() => {
    const markVisibleConversationSeen = () => {
      const chat = selectedRef.current
      if (document.visibilityState === 'visible' && chat?.kind === 'direct') {
        void api.markDirectSeen(token, chat.name).catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', markVisibleConversationSeen)
    return () => document.removeEventListener('visibilitychange', markVisibleConversationSeen)
  }, [token])
  useEffect(() => () => {
    if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current)
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
    recordingStreamRef.current?.getTracks().forEach(track => track.stop())
  }, [])
  useEffect(() => { if (toast) { const id = window.setTimeout(() => setToast(''), 3500); return () => clearTimeout(id) } }, [toast])
  useEffect(() => {
    const messageArea = messageAreaRef.current
    if (!messageArea) return

    // Scroll only the conversation container. scrollIntoView() can also move
    // the browser viewport, which previously pushed the app off-screen.
    const frame = window.requestAnimationFrame(() => {
      messageArea.scrollTop = messageArea.scrollHeight
    })

    return () => window.cancelAnimationFrame(frame)
  }, [messages])

  const sendSignal = useCallback((event: object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(event))
  }, [])
  const calls = useWebRTC(sendSignal, setToast)
  useEffect(() => {
    signalHandler.current = calls.handleSignal
  }, [calls.handleSignal]);
  

  const loadContacts = useCallback(async () => {
    try {
      const [people, rooms, candidates] = await Promise.all([
        api.conversations(token),
        api.groups(token),
        api.users(token),
      ])
      setConversations(people)
      setGroups(rooms)
      setGroupCandidates(candidates)
    } catch (error) { setToast(errorMessage(error)) }
  }, [token])

  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadContacts() }, 0)
    const interval = window.setInterval(loadContacts, 30_000)
    return () => {
      window.clearTimeout(timeout)
      window.clearInterval(interval)
    }
  }, [loadContacts])

  useEffect(() => {
    const syncGroup = (current: ChatTarget | null) => {
      if (current?.kind !== 'group') return current
      const latest = groups.find(group => group.id === current.id)
      return latest ? groupTarget(latest) : current
    }
    const timeout = window.setTimeout(() => {
      setSelected(syncGroup)
      setManageGroup(current => syncGroup(current) as GroupTarget | null)
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [groups])

  useEffect(() => {
    const query = search.trim()
    let cancelled = false
    const timeout = window.setTimeout(async () => {
      if (cancelled) return

      if (!query) {
        setSearchResults([])
        setSearching(false)
        return
      }

      setSearching(true)
      try {
        const results = await api.users(token, query)
        if (!cancelled) setSearchResults(results)
      } catch (error) {
        if (!cancelled) setToast(errorMessage(error))
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, query ? 250 : 0)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [search, token])

  useEffect(() => {
    let reconnectTimer = 0
    let closed = false
    function connect() {
      const socket = new WebSocket(socketUrl(token))
      socketRef.current = socket
      socket.onopen = () => setSocketOnline(true)
      socket.onclose = () => {
        setSocketOnline(false)
        if (!closed) reconnectTimer = window.setTimeout(connect, 2000)
      }
      socket.onmessage = raw => {
        const event = JSON.parse(raw.data) as SocketEvent
        if (event.type.startsWith('call_') || event.type === 'ice_candidate') {
          signalHandler.current(event)
          return
        }
        if (event.type === 'message_receipt') {
          const receipt = event.data as MessageReceipt
          setMessages(previous => previous.map(message => (
            message.group_id === null &&
            message.sender === currentUser.username &&
            message.recipient === receipt.peer &&
            message.id <= receipt.up_to_id &&
            RECEIPT_RANK[receipt.status] > RECEIPT_RANK[message.delivery_status ?? 'sent']
              ? { ...message, delivery_status: receipt.status }
              : message
          )))
          return
        }
        if (event.type === 'group_added' || event.type === 'group_members_changed' || event.type === 'group_removed' || event.type === 'group_updated') {
          const groupEvent = event.data as {
            group_id: number
            member_count?: number
            name?: string
            description?: string
            profile_media_id?: number | null
          }
          if (event.type === 'group_removed') {
            setGroups(previous => previous.filter(group => group.id !== groupEvent.group_id))
            setManageGroup(current => current?.id === groupEvent.group_id ? null : current)
            if (selectedRef.current?.kind === 'group' && selectedRef.current.id === groupEvent.group_id) {
              selectedRef.current = null
              setSelected(null)
              setMessages([])
            }
          } else if (groupEvent.member_count !== undefined) {
            setGroups(previous => previous.map(group => group.id === groupEvent.group_id ? { ...group, member_count: groupEvent.member_count! } : group))
            setSelected(current => current?.kind === 'group' && current.id === groupEvent.group_id ? { ...current, memberCount: groupEvent.member_count! } : current)
            setManageGroup(current => current?.id === groupEvent.group_id ? { ...current, memberCount: groupEvent.member_count! } : current)
          } else if (event.type === 'group_updated') {
            const applyUpdate = (group: GroupTarget) => ({
              ...group,
              name: groupEvent.name ?? group.name,
              description: groupEvent.description ?? group.description,
              profileMediaId: groupEvent.profile_media_id === undefined ? group.profileMediaId : groupEvent.profile_media_id,
            })
            setSelected(current => current?.kind === 'group' && current.id === groupEvent.group_id ? applyUpdate(current) : current)
            setManageGroup(current => current?.id === groupEvent.group_id ? applyUpdate(current) : current)
          }
          void loadContacts()
          return
        }
        if (event.type !== 'message') return
        const message = event.data as Message
        const active = selectedRef.current
        const matches = active && (
          (active.kind === 'group' && message.group_id === active.id) ||
          (active.kind === 'direct' && message.group_id === null && (message.sender === active.name || message.recipient === active.name))
        )
        if (matches) {
          setMessages(previous => previous.some(item => item.id === message.id) ? previous : [...previous, message])
          if (
            document.visibilityState === 'visible' &&
            active.kind === 'direct' &&
            message.sender === active.name
          ) void api.markDirectSeen(token, active.name).catch(() => {})
        } else {
          const sender = usersRef.current.find(item => item.username === message.sender)
          const key = message.group_id ? `group:${message.group_id}` : `direct:${sender?.id ?? message.sender}`
          setUnread(previous => ({ ...previous, [key]: (previous[key] ?? 0) + 1 }))
        }
        void loadContacts()
      }
    }
    connect()
    return () => { closed = true; window.clearTimeout(reconnectTimer); socketRef.current?.close() }
  }, [currentUser.username, loadContacts, token])

  async function selectChat(chat: ChatTarget) {
    cancelVoiceRecording()
    selectedRef.current = chat
    setSelected(chat)
    setSearch('')
    setShowMobileSidebar(false)
    setUnread(previous => ({ ...previous, [chatKey(chat)]: 0 }))
    setLoadingChat(true)
    try {
      const history = chat.kind === 'direct' ? await api.directHistory(token, chat.name) : await api.groupHistory(token, chat.id)
      setMessages(history)
      if (chat.kind === 'direct' && document.visibilityState === 'visible') {
        void api.markDirectSeen(token, chat.name).catch(() => {})
      }
    } catch (error) { setToast(errorMessage(error)); setMessages([]) }
    finally { setLoadingChat(false) }
  }

  async function sendMessage(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || (!text.trim() && !file) || sending) return
    setSending(true)
    try {
      const mediaId = file ? (await api.upload(token, file)).id : undefined
      const message = selected.kind === 'direct'
        ? await api.sendDirect(token, selected.name, text.trim(), mediaId)
        : await api.sendGroup(token, selected.id, text.trim(), mediaId)
      setMessages(previous => (
        previous.some(existing => existing.id === message.id)
          ? previous
          : [...previous, message]
      ))
      setText('')
      setFile(null)
      void loadContacts()
      if (fileInput.current) fileInput.current.value = ''
    } catch (error) { setToast(errorMessage(error)) }
    finally { setSending(false) }
  }

  function finishRecordingSession() {
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current)
      recordingTimerRef.current = null
    }
    recordingStreamRef.current?.getTracks().forEach(track => track.stop())
    recordingStreamRef.current = null
    mediaRecorderRef.current = null
    setRecording(false)
    setRecordingSeconds(0)
  }

  function cancelVoiceRecording() {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
    recordingChunksRef.current = []
    finishRecordingSession()
  }

  async function sendVoiceNote(voiceNote: File) {
    const chat = selectedRef.current
    if (!chat || sending) return
    setSending(true)
    try {
      const mediaId = (await api.upload(token, voiceNote)).id
      const message = chat.kind === 'direct'
        ? await api.sendDirect(token, chat.name, VOICE_NOTE_CONTENT, mediaId)
        : await api.sendGroup(token, chat.id, VOICE_NOTE_CONTENT, mediaId)
      setMessages(previous => previous.some(item => item.id === message.id) ? previous : [...previous, message])
      void loadContacts()
    } catch (error) { setToast(errorMessage(error)) }
    finally { setSending(false) }
  }

  async function startVoiceRecording() {
    if (!selected || sending || recording) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setToast('Voice recording is not supported in this browser.')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find(type => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)

      recordingStreamRef.current = stream
      recordingChunksRef.current = []
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = event => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        setToast('The voice recording failed. Please try again.')
        cancelVoiceRecording()
      }
      recorder.onstop = () => {
        const chunks = recordingChunksRef.current
        const recordedType = recorder.mimeType || mimeType || 'audio/webm'
        recordingChunksRef.current = []
        finishRecordingSession()
        const blob = new Blob(chunks, { type: recordedType })
        if (!blob.size) {
          setToast('No audio was captured. Please try again.')
          return
        }
        const extension = recordedType.includes('ogg') ? 'ogg' : recordedType.includes('mp4') ? 'm4a' : 'webm'
        void sendVoiceNote(new File([blob], `voice-note-${Date.now()}.${extension}`, { type: recordedType }))
      }

      recorder.start()
      setRecording(true)
      setRecordingSeconds(0)
      recordingTimerRef.current = window.setInterval(() => setRecordingSeconds(value => value + 1), 1000)
    } catch (error) {
      finishRecordingSession()
      setToast(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone permission was denied.'
        : 'Could not access your microphone.')
    }
  }

  function stopVoiceRecording() {
    const recorder = mediaRecorderRef.current
    if (recorder?.state === 'recording') recorder.stop()
  }

  async function downloadAttachment(mediaId: number) {
    try {
      const { blob, filename } = await api.download(token, mediaId)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) { setToast(errorMessage(error)) }
  }

  return (
    <main className="chat-shell">
      <aside
        id="chat-sidebar"
        className={`sidebar ${showMobileSidebar ? 'mobile-open' : ''} ${sidebarCollapsed ? 'collapsed' : ''}`}
      >
        <header className="sidebar-header">
          <button
            type="button"
            className="mini-logo"
            onClick={() => {
              if (window.innerWidth <= 800) {
                setShowMobileSidebar((current) => !current)
              } else {
                setSidebarCollapsed((current) => !current)
              }
            }}
            aria-controls="chat-sidebar"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            W<span>3</span>
          </button>
          <div><strong>W3SHUŌ</strong><small><i className={socketOnline ? 'online' : ''} />{socketOnline ? 'Connected' : 'Reconnecting…'}</small></div>
          <button className="icon-button" onClick={onLogout} title="Log out"><LogOut size={18} /></button>
        </header>
        <div className="search-box"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search by username" /></div>
        <div className="sidebar-scroll">
          <div className="section-title"><span>{search.trim() ? 'SEARCH RESULTS' : 'MESSAGES'}</span><span>{search.trim() ? searchResults.length : conversations.length}</span></div>
          <div className="chat-list">
            {(search.trim() ? searchResults : conversations).map(user => {
              const target: ChatTarget = { kind: 'direct', id: user.id, name: user.username, online: user.online, lastSeen: user.last_seen, profileMediaId: user.profile_media_id }
              const count = unread[chatKey(target)] ?? 0
              return <button key={user.id} className={selected?.kind === 'direct' && selected.id === user.id ? 'active' : ''} onClick={() => selectChat(target)}>
                <span className="avatar"><GroupPicture token={token} mediaId={user.profile_media_id ?? null} fallback={avatar(user.username)} /><i className={user.online ? 'online' : ''} /></span>
                <span className="chat-label"><strong>{user.username}</strong><small>{user.online ? 'Online' : user.last_seen ? 'Offline' : 'Start a conversation'}</small></span>
                {count > 0 && <b className="unread">{count}</b>}
              </button>
            })}
            {search.trim() && searching && <p className="empty-list">Searching…</p>}
            {search.trim() && !searching && !searchResults.length && <p className="empty-list">No users found.</p>}
            {!search.trim() && !conversations.length && <p className="empty-list">No conversations yet. Search for someone to get started.</p>}
          </div>
          <div className="section-title"><span>GROUPS</span><button onClick={() => setShowGroupModal(true)} title="Create group"><Plus size={15} /></button></div>
          <div className="chat-list">
            {groups.map(group => {
              const target = groupTarget(group)
              const count = unread[chatKey(target)] ?? 0
              return <button key={group.id} className={selected?.kind === 'group' && selected.id === group.id ? 'active' : ''} onClick={() => selectChat(target)}>
                <span className="avatar group"><GroupPicture token={token} mediaId={group.profile_media_id} fallback={<Hash size={20} />} /></span>
                <span className="chat-label"><strong>{group.name}</strong><small>{group.member_count} members</small></span>
                {count > 0 && <b className="unread">{count}</b>}
              </button>
            })}
          </div>
        </div>
        <footer className="profile-card">
          <span className="avatar"><GroupPicture token={token} mediaId={currentUser.profile_media_id ?? null} fallback={avatar(currentUser.username)} /><i className="online" /></span>
          <span><strong>{currentUser.username}</strong><small>Available</small></span>
          <button type="button" className="profile-menu-button" onClick={() => setShowAccountSettings(true)} aria-label="Open account settings" title="Account settings"><MoreVertical size={18} /></button>
        </footer>
      </aside>

      <section className={`conversation ${selected ? 'has-chat' : ''}`}>
        {!selected ? <EmptyChat onOpenSidebar={() => setShowMobileSidebar(true)} /> : <>
          <header className="conversation-header">
            <button className="mobile-back" onClick={() => setShowMobileSidebar(true)}><ArrowLeft size={20} /></button>
            <span className={`avatar ${selected.kind === 'group' ? 'group' : ''}`}>{selected.kind === 'group' ? <GroupPicture token={token} mediaId={selected.profileMediaId} fallback={<UsersRound size={20} />} /> : <GroupPicture token={token} mediaId={selected.profileMediaId ?? null} fallback={avatar(selected.name)} />}{selected.kind === 'direct' && <i className={selected.online ? 'online' : ''} />}</span>
            <div><strong>{selected.name}</strong><small>{selected.kind === 'group' ? selected.description || `${selected.memberCount} members` : selected.online ? 'Online now' : 'Offline'}</small></div>
            <span className="header-spacer" />
            {selected.kind === 'group' && <button className="icon-button" onClick={() => setManageGroup(selected)} aria-label="Open group menu" title="Group menu"><MoreVertical size={20} /></button>}
            {selected.kind === 'direct' && <>
              <button className="icon-button" disabled={!selected.online} onClick={() => calls.startCall(selected.name, 'audio')} aria-label="Audio call" title={selected.online ? 'Audio call' : 'User is offline'}><Phone size={19} /></button>
              <button className="icon-button" disabled={!selected.online} onClick={() => calls.startCall(selected.name, 'video')} aria-label="Video call" title={selected.online ? 'Video call' : 'User is offline'}><Video size={20} /></button>
            </>}
          </header>
          <div ref={messageAreaRef} className="message-area">
            {loadingChat ? <div className="message-loader"><i /><span>Loading conversation…</span></div> : !messages.length ? <div className="conversation-empty"><MessageCircleMore size={38} /><h3>No messages yet</h3><p>Start the conversation. A suspiciously empty chat deserves fixing.</p></div> : messages.map((message, index) => {
              const mine = message.sender === currentUser.username
              const startsNewDay = index === 0 || calendarDay(messages[index - 1].created_at) !== calendarDay(message.created_at)
              const previous = messages[index - 1]
              const showSender = selected.kind === 'group' && !mine && (
                startsNewDay || previous?.is_system || previous?.sender !== message.sender
              )
              return <Fragment key={message.id}>
                {startsNewDay && <div className="date-separator"><span>{displayMessageDate(message.created_at)}</span></div>}
                {message.is_system
                  ? <div className="system-message" role="status">{message.content}</div>
                  : <article className={`message-row ${mine ? 'mine' : ''}`}>
                    {!mine && selected.kind === 'group' && <span className="message-avatar">{avatar(message.sender)}</span>}
                    <div className="bubble-wrap">{showSender && <small className="sender-name">{message.sender}</small>}<div className="message-bubble">
                      {message.media_id && message.content === VOICE_NOTE_CONTENT
                        ? <VoiceNotePlayer token={token} mediaId={message.media_id} onError={setToast} />
                        : <>{message.content && <p>{message.content}</p>}{message.media_id && <button className="attachment" onClick={() => downloadAttachment(message.media_id!)}><ArrowDownToLine size={18} /><span><strong>Attachment</strong><small>Click to download</small></span></button>}</>}
                      <div className="message-meta">
                        <time>{displayTime(message.created_at, currentUser.time_format ?? '12')}</time>
                        {mine && <MessageTicks status={selected.kind === 'direct' ? message.delivery_status ?? 'sent' : 'sent'} />}
                      </div>
                    </div></div>
                  </article>}
              </Fragment>
            })}
            <div aria-hidden="true" />
          </div>
          <form className="composer" onSubmit={sendMessage}>
            {file && <div className="selected-file"><Paperclip size={15} /><span>{file.name}</span><button type="button" onClick={() => setFile(null)}><X size={15} /></button></div>}
            {recording && <div className="voice-recording"><i /><span>Recording {Math.floor(recordingSeconds / 60)}:{String(recordingSeconds % 60).padStart(2, '0')}</span><small>Tap stop to send</small></div>}
            <div className="composer-row">
              <input ref={fileInput} type="file" hidden onChange={event => setFile(event.target.files?.[0] ?? null)} />
              <button type="button" className="icon-button" disabled={recording} onClick={() => fileInput.current?.click()} title="Attach file"><Paperclip size={20} /></button>
              <textarea disabled={recording} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder={recording ? 'Recording voice note…' : `Message ${selected.name}`} rows={1} />
              <button type="button" className="icon-button decorative" disabled={recording} title="Emoji"><Smile size={20} /></button>
              {recording
                ? <button type="button" className="send-button voice-button recording" disabled={sending} onClick={stopVoiceRecording} aria-label="Stop and send voice note" title="Stop and send voice note"><Square size={16} fill="currentColor" /></button>
                : text.trim() || file
                  ? <button className="send-button" disabled={sending} aria-label="Send" title="Send"><Send size={19} /></button>
                  : <button type="button" className="send-button voice-button" disabled={sending} onClick={startVoiceRecording} aria-label="Record voice note" title="Record voice note"><Mic size={20} /></button>}
            </div>
          </form>
        </>}
      </section>

      {showGroupModal && <CreateGroupModal users={groupCandidates} token={token} onClose={() => setShowGroupModal(false)} onCreated={() => { setShowGroupModal(false); void loadContacts() }} onError={setToast} />}
      {manageGroup && <ManageGroupMembersModal
        group={manageGroup}
        currentUser={currentUser}
        candidates={groupCandidates}
        token={token}
        onClose={() => setManageGroup(null)}
        onChanged={updated => {
          setGroups(previous => previous.map(group => group.id === updated.id ? {
            ...group,
            name: updated.name,
            description: updated.description,
            member_count: updated.memberCount,
            profile_media_id: updated.profileMediaId,
            role: updated.role,
          } : group))
          setSelected(current => current?.kind === 'group' && current.id === updated.id ? updated : current)
          setManageGroup(updated)
          void loadContacts()
        }}
        onError={setToast}
      />}
      {showAccountSettings && <AccountSettingsModal
        token={token}
        currentUser={currentUser}
        onClose={() => setShowAccountSettings(false)}
        onSessionUpdated={onSessionUpdated}
        onNotice={setToast}
      />}
      {calls.call && <CallOverlay call={calls.call} localStream={calls.localStream} remoteStream={calls.remoteStream} onAccept={calls.acceptCall} onReject={calls.rejectCall} onEnd={calls.endCall} />}
      {toast && <div className="toast" role="status">{toast}<button onClick={() => setToast('')}><X size={15} /></button></div>}
    </main>
  )
}

function EmptyChat({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  return <div className="empty-chat">
    <button className="mobile-menu" onClick={onOpenSidebar}><Menu size={22} /></button>
    <div className="empty-symbol"><MessageCircleMore size={42} /><i /><i /></div>
    <p className="eyebrow">PRIVATE BY DESIGN</p><h1>Your conversations,<br /><span>all in one place.</span></h1>
    <p>Select a person or group to start chatting. Your message history stays available across devices.</p>
  </div>
}

function CreateGroupModal({ users, token, onClose, onCreated, onError }: { users: User[]; token: string; onClose: () => void; onCreated: () => void; onError: (text: string) => void }) {
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true)
    try { await api.createGroup(token, name.trim(), members); onCreated() }
    catch (error) { onError(errorMessage(error)) }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <form className="modal-card" onSubmit={submit}>
      <header><div><p className="eyebrow">NEW SPACE</p><h2>Create a group</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={20} /></button></header>
      <label htmlFor="groupName">Group name</label><input id="groupName" value={name} onChange={event => setName(event.target.value)} minLength={3} maxLength={60} placeholder="e.g. Project team" required />
      <label>Add members</label><div className="member-picker">{users.map(user => <label key={user.id}><input type="checkbox" checked={members.includes(user.username)} onChange={() => setMembers(current => current.includes(user.username) ? current.filter(name => name !== user.username) : [...current, user.username])} /><span className="avatar">{avatar(user.username)}</span><span>{user.username}</span></label>)}</div>
      <button className="primary-button" disabled={busy}>{busy ? 'CREATING…' : 'CREATE GROUP'}</button>
    </form>
  </div>
}

function VoiceNotePlayer({ token, mediaId, onError }: { token: string; mediaId: number; onError: (text: string) => void }) {
  const [source, setSource] = useState('')

  useEffect(() => {
    let objectUrl = ''
    let cancelled = false
    api.download(token, mediaId).then(({ blob }) => {
      if (cancelled) return
      objectUrl = URL.createObjectURL(blob)
      setSource(objectUrl)
    }).catch(error => { if (!cancelled) onError(errorMessage(error)) })

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [mediaId, onError, token])

  return <div className="voice-note"><Mic size={18} />{source ? <audio controls preload="metadata" src={source} /> : <span>Loading voice note…</span>}</div>
}

function GroupPicture({ token, mediaId, fallback, onError }: {
  token: string
  mediaId: number | null
  fallback: ReactNode
  onError?: (text: string) => void
}) {
  const [source, setSource] = useState('')

  useEffect(() => {
    let objectUrl = ''
    let cancelled = false
    if (mediaId === null) return
    api.download(token, mediaId).then(({ blob }) => {
      if (cancelled) return
      objectUrl = URL.createObjectURL(blob)
      setSource(objectUrl)
    }).catch(error => { if (!cancelled) onError?.(errorMessage(error)) })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [mediaId, onError, token])

  return source ? <img className="group-picture" src={source} alt="" /> : <>{fallback}</>
}

function AccountSettingsModal({ token, currentUser, onClose, onSessionUpdated, onNotice }: {
  token: string
  currentUser: AuthUser
  onClose: () => void
  onSessionUpdated: (token: string, user: AuthUser) => void
  onNotice: (text: string) => void
}) {
  const [username, setUsername] = useState(currentUser.username)
  const [dateOfBirth, setDateOfBirth] = useState(currentUser.date_of_birth ?? '')
  const [timeFormat, setTimeFormat] = useState<'12' | '24'>(currentUser.time_format ?? '12')
  const [picture, setPicture] = useState<File | null>(null)
  const [removePicture, setRemovePicture] = useState(false)
  const [usernamePassword, setUsernamePassword] = useState('')
  const [showUsernamePassword, setShowUsernamePassword] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const usernameChanged = username.trim() !== currentUser.username
  const today = new Date().toISOString().slice(0, 10)

  async function saveProfile(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (savingProfile) return
    setSavingProfile(true)
    try {
      let profileMediaId: number | null | undefined
      if (picture) {
        if (!picture.type.startsWith('image/')) throw new Error('Profile picture must be an image.')
        profileMediaId = (await api.upload(token, picture)).id
      } else if (removePicture) {
        profileMediaId = null
      }
      const result = await api.updateAccount(token, {
        username: username.trim(),
        date_of_birth: dateOfBirth || null,
        time_format: timeFormat,
        ...(usernameChanged ? { current_password: usernamePassword } : {}),
        ...(profileMediaId !== undefined ? { profile_media_id: profileMediaId } : {}),
      })
      setPicture(null)
      setRemovePicture(false)
      setUsernamePassword('')
      onSessionUpdated(result.access_token, result.user)
      onNotice('Account settings saved.')
    } catch (error) { onNotice(errorMessage(error)) }
    finally { setSavingProfile(false) }
  }

  async function savePassword(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (savingPassword) return
    if (newPassword !== confirmPassword) {
      onNotice('New passwords do not match.')
      return
    }
    setSavingPassword(true)
    try {
      await api.changePassword(token, currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      onNotice('Password changed successfully.')
    } catch (error) { onNotice(errorMessage(error)) }
    finally { setSavingPassword(false) }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal-card account-settings" role="dialog" aria-modal="true" aria-label="Account settings">
      <header><div><p className="eyebrow">YOUR ACCOUNT</p><h2>Settings</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close settings"><X size={20} /></button></header>

      <form className="settings-section" onSubmit={saveProfile}>
        <div className="settings-section-title"><div><strong>Profile & privacy</strong><small>Your date of birth stays private.</small></div></div>
        <div className="account-photo-row">
          <span className="group-photo-preview"><GroupPicture token={token} mediaId={removePicture ? null : currentUser.profile_media_id ?? null} fallback={avatar(currentUser.username)} onError={onNotice} /></span>
          <div><strong>Profile picture</strong><small>{picture ? picture.name : currentUser.profile_media_id && !removePicture ? 'Current picture' : 'No picture selected'}</small></div>
          <label className="photo-action"><Camera size={17} /><span>Choose</span><input type="file" accept="image/*" onChange={event => { setPicture(event.target.files?.[0] ?? null); setRemovePicture(false) }} /></label>
          {currentUser.profile_media_id && !removePicture && <button type="button" className="text-action danger" onClick={() => { setPicture(null); setRemovePicture(true) }}>Remove</button>}
        </div>

        <div className="settings-grid">
          <label htmlFor="accountUsername">Username</label>
          <input id="accountUsername" value={username} onChange={event => setUsername(event.target.value)} minLength={3} maxLength={30} autoComplete="username" required />
          <label htmlFor="dateOfBirth">Date of birth</label>
          <input id="dateOfBirth" type="date" max={today} value={dateOfBirth} onChange={event => setDateOfBirth(event.target.value)} />
          <label htmlFor="timeFormat"><Clock3 size={15} /> Chat time format</label>
          <select id="timeFormat" value={timeFormat} onChange={event => setTimeFormat(event.target.value as '12' | '24')}>
            <option value="12">12-hour — 3:45 PM</option>
            <option value="24">24-hour — 15:45</option>
          </select>
        </div>

        {usernameChanged && <div className="settings-sensitive-field">
          <label htmlFor="usernameCurrentPassword"><KeyRound size={15} /> Current password to change username</label>
          <div className="settings-password-field"><input id="usernameCurrentPassword" type={showUsernamePassword ? 'text' : 'password'} value={usernamePassword} onChange={event => setUsernamePassword(event.target.value)} autoComplete="current-password" required /><button type="button" onClick={() => setShowUsernamePassword(value => !value)} aria-label={showUsernamePassword ? 'Hide password' : 'Show password'}>{showUsernamePassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
        </div>}
        <p className="privacy-note">Your birthday is only available in your private account settings. Other users cannot see it.</p>
        <div className="settings-actions"><button className="primary-button compact" disabled={savingProfile}>{savingProfile ? 'SAVING…' : 'SAVE PROFILE'}</button></div>
      </form>

      <form className="settings-section password-settings" onSubmit={savePassword}>
        <div className="settings-section-title"><div><strong>Change password</strong><small>Confirm your current password first.</small></div></div>
        <div className="password-settings-grid">
          <label htmlFor="currentAccountPassword">Current password</label>
          <div className="settings-password-field"><input id="currentAccountPassword" type={showCurrentPassword ? 'text' : 'password'} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" required /><button type="button" onClick={() => setShowCurrentPassword(value => !value)} aria-label={showCurrentPassword ? 'Hide current password' : 'Show current password'}>{showCurrentPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
          <label htmlFor="newAccountPassword">New password</label>
          <div className="settings-password-field"><input id="newAccountPassword" type={showNewPassword ? 'text' : 'password'} value={newPassword} onChange={event => setNewPassword(event.target.value)} minLength={8} autoComplete="new-password" required /><button type="button" onClick={() => setShowNewPassword(value => !value)} aria-label={showNewPassword ? 'Hide new passwords' : 'Show new passwords'}>{showNewPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
          <label htmlFor="confirmAccountPassword">Confirm new password</label>
          <input id="confirmAccountPassword" type={showNewPassword ? 'text' : 'password'} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} minLength={8} autoComplete="new-password" required />
        </div>
        <div className="settings-actions"><button className="primary-button compact" disabled={savingPassword}>{savingPassword ? 'CHANGING…' : 'CHANGE PASSWORD'}</button></div>
      </form>
    </section>
  </div>
}

function ManageGroupMembersModal({ group, currentUser, candidates, token, onClose, onChanged, onError }: {
  group: GroupTarget
  currentUser: AuthUser
  candidates: User[]
  token: string
  onClose: () => void
  onChanged: (group: GroupTarget) => void
  onError: (text: string) => void
}) {
  const [members, setMembers] = useState<GroupMember[]>([])
  const [name, setName] = useState(group.name)
  const [description, setDescription] = useState(group.description)
  const [picture, setPicture] = useState<File | null>(null)
  const [removePicture, setRemovePicture] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [busyUser, setBusyUser] = useState('')
  const isOwner = currentUser.id === group.creatorId
  const isAdmin = group.role === 'admin'

  useEffect(() => {
    // Defer updates to avoid synchronous setState within the effect body
    const timer = window.setTimeout(() => {
      setName(group.name)
      setDescription(group.description)
    }, 0)
    return () => { window.clearTimeout(timer) }
  }, [group.description, group.name])

  const refreshMembers = useCallback(async () => {
    setLoading(true)
    try { setMembers(await api.groupMembers(token, group.id)) }
    catch (error) { onError(errorMessage(error)) }
    finally { setLoading(false) }
  }, [group.id, onError, token])

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshMembers() }, 0)
    return () => { window.clearTimeout(timer) }
  }, [refreshMembers])

  const currentMembers = members.filter(member => member.membership_status === 'current')
  const pastMembers = members.filter(member => member.membership_status === 'past')
  const currentNames = new Set(currentMembers.map(member => member.username.toLowerCase()))
  const available = candidates.filter(candidate => (
    !currentNames.has(candidate.username.toLowerCase()) &&
    candidate.username.toLowerCase().includes(query.trim().toLowerCase())
  ))

  async function saveDetails(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!isAdmin || saving) return
    setSaving(true)
    try {
      let profileMediaId: number | null | undefined
      if (picture) {
        if (!picture.type.startsWith('image/')) throw new Error('Group profile picture must be an image.')
        profileMediaId = (await api.upload(token, picture)).id
      } else if (removePicture) {
        profileMediaId = null
      }
      const updated = await api.updateGroup(token, group.id, {
        name: name.trim(),
        description: description.trim(),
        ...(profileMediaId !== undefined ? { profile_media_id: profileMediaId } : {}),
      })
      setPicture(null)
      setRemovePicture(false)
      onChanged(groupTarget(updated))
    } catch (error) { onError(errorMessage(error)) }
    finally { setSaving(false) }
  }

  async function addMember(user: User) {
    setBusyUser(user.username)
    try {
      const result = await api.addGroupMember(token, group.id, user.username)
      await refreshMembers()
      onChanged({ ...group, memberCount: result.member_count })
      setQuery('')
    } catch (error) { onError(errorMessage(error)) }
    finally { setBusyUser('') }
  }

  async function removeMember(member: GroupMember) {
    setBusyUser(member.username)
    try {
      const result = await api.removeGroupMember(token, group.id, member.username)
      await refreshMembers()
      onChanged({ ...group, memberCount: result.member_count })
    } catch (error) { onError(errorMessage(error)) }
    finally { setBusyUser('') }
  }

  async function toggleAdmin(member: GroupMember) {
    setBusyUser(member.username)
    try {
      const result = await api.setGroupAdmin(token, group.id, member.username, member.role !== 'admin')
      setMembers(current => current.map(item => item.id === member.id ? { ...item, role: result.role } : item))
    } catch (error) { onError(errorMessage(error)) }
    finally { setBusyUser('') }
  }

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="modal-card group-settings" role="dialog" aria-modal="true" aria-label={`Settings for ${group.name}`}>
      <header><div><p className="eyebrow">GROUP MENU</p><h2>{group.name}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={20} /></button></header>

      <form className="group-details-form" onSubmit={saveDetails}>
        <div className="group-photo-editor">
          <span className="group-photo-preview"><GroupPicture token={token} mediaId={removePicture ? null : group.profileMediaId} fallback={<UsersRound size={30} />} onError={onError} /></span>
          <div><strong>Group picture</strong><small>{picture ? picture.name : group.profileMediaId && !removePicture ? 'Current picture' : 'No picture selected'}</small></div>
          {isAdmin && <label className="photo-action"><Camera size={17} /><span>Choose</span><input type="file" accept="image/*" onChange={event => { setPicture(event.target.files?.[0] ?? null); setRemovePicture(false) }} /></label>}
          {isAdmin && group.profileMediaId && !removePicture && <button type="button" className="text-action danger" onClick={() => { setPicture(null); setRemovePicture(true) }}>Remove</button>}
        </div>
        <label htmlFor="editGroupName">Group name</label>
        <input id="editGroupName" value={name} onChange={event => setName(event.target.value)} minLength={3} maxLength={60} disabled={!isAdmin} required />
        <label htmlFor="groupDescription">Description</label>
        <textarea id="groupDescription" value={description} onChange={event => setDescription(event.target.value)} maxLength={500} disabled={!isAdmin} placeholder="What is this group about?" rows={3} />
        {isAdmin ? <button className="primary-button compact" disabled={saving}>{saving ? 'SAVING…' : 'SAVE GROUP DETAILS'}</button> : <p className="member-note">Only group admins can edit the group details.</p>}
      </form>

      <div className="member-heading"><span>Current members</span><b>{currentMembers.length}</b></div>
      <div className="group-member-list">
        {loading ? <p className="empty-list">Loading members…</p> : currentMembers.map(member => <div className="group-member-row" key={member.id}>
          <span className="avatar">{avatar(member.username)}<i className={member.online ? 'online' : ''} /></span>
          <span><strong>{member.username}</strong><small>{member.id === group.creatorId ? 'Owner' : member.role === 'admin' ? 'Admin' : member.online ? 'Member · Online' : 'Member · Offline'}</small></span>
          {member.id === group.creatorId && <Crown className="owner-mark" size={17} aria-label="Group owner" />}
          {isOwner && member.id !== group.creatorId && <button type="button" className={`member-action ${member.role === 'admin' ? 'demote' : 'promote'}`} disabled={Boolean(busyUser)} onClick={() => toggleAdmin(member)} aria-label={member.role === 'admin' ? `Revoke admin rights from ${member.username}` : `Make ${member.username} an admin`} title={member.role === 'admin' ? 'Revoke admin rights' : 'Make admin'}>{member.role === 'admin' ? <ShieldOff size={17} /> : <Shield size={17} />}</button>}
          {isOwner && member.id !== group.creatorId && <button type="button" className="member-action remove" disabled={Boolean(busyUser)} onClick={() => removeMember(member)} aria-label={`Remove ${member.username}`} title="Remove member"><UserMinus size={17} /></button>}
        </div>)}
      </div>

      {isAdmin && <>
        <label htmlFor="memberSearch">Add a member</label>
        <div className="member-search"><Search size={16} /><input id="memberSearch" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by username" /></div>
        <div className="group-member-list available-members">
          {available.map(user => <div className="group-member-row" key={user.id}>
            <span className="avatar">{avatar(user.username)}<i className={user.online ? 'online' : ''} /></span>
            <span><strong>{user.username}</strong><small>{user.online ? 'Online' : 'Offline'}</small></span>
            <button type="button" className="member-action add" disabled={Boolean(busyUser)} onClick={() => addMember(user)} aria-label={`Add ${user.username}`} title="Add member"><UserPlus size={17} /></button>
          </div>)}
          {!available.length && <p className="empty-list">{query ? 'No matching users available.' : 'Everyone is already in this group.'}</p>}
        </div>
      </>}

      <div className="member-heading past-heading"><span>Past members</span><b>{pastMembers.length}</b></div>
      <div className="group-member-list past-members">
        {pastMembers.map(member => <div className="group-member-row" key={member.id}>
          <span className="avatar past">{avatar(member.username)}</span>
          <span><strong>{member.username}</strong><small>{member.left_at ? `Left ${new Date(member.left_at).toLocaleDateString()}` : 'No longer a member'}</small></span>
        </div>)}
        {!loading && !pastMembers.length && <p className="empty-list">No past members.</p>}
      </div>
    </section>
  </div>
}

function MessageTicks({ status }: { status: Message['delivery_status'] }) {
  const label = status === 'seen' ? 'Seen' : status === 'delivered' ? 'Delivered' : 'Sent'
  return <span className={`message-ticks ${status}`} aria-label={label} title={label}>
    {status === 'sent' ? <Check size={14} /> : <CheckCheck size={15} />}
  </span>
}
