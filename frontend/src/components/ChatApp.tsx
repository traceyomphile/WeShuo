import { useCallback, useEffect, useRef, useState } from 'react'
import type { SubmitEvent } from 'react'
import {
  ArrowDownToLine, ArrowLeft, Hash, LogOut, Menu, MessageCircleMore,
  Mic, MoreVertical, Paperclip, Plus, Search, Send, Smile, UsersRound, Video, X,
} from 'lucide-react'
import { api, socketUrl } from '../api'
import { errorMessage } from '../utils/errors'
import { useWebRTC } from '../hooks/useWebRTC'
import type { AuthUser, ChatTarget, Group, Message, SocketEvent, User } from '../types'
import CallOverlay from './CallOverlay'

interface Props { token: string; currentUser: AuthUser; onLogout: () => void }

function avatar(name: string) { return name.slice(0, 2).toUpperCase() }
function chatKey(chat: ChatTarget) { return `${chat.kind}:${chat.id}` }
function displayTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function ChatApp({ token, currentUser, onLogout }: Props) {
  const [users, setUsers] = useState<User[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [selected, setSelected] = useState<ChatTarget | null>(null)
  const selectedRef = useRef<ChatTarget | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [search, setSearch] = useState('')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [loadingChat, setLoadingChat] = useState(false)
  const [sending, setSending] = useState(false)
  const [socketOnline, setSocketOnline] = useState(false)
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [showMobileSidebar, setShowMobileSidebar] = useState(true)
  const [showGroupModal, setShowGroupModal] = useState(false)
  const [toast, setToast] = useState('')
  const socketRef = useRef<WebSocket | null>(null)
  const usersRef = useRef<User[]>([])
  const messageAreaRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const signalHandler = useRef<(event: SocketEvent) => void>(() => {})

  useEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { usersRef.current = users }, [users])
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
  

  const loadContacts = useCallback(async (query = '') => {
    try {
      const [people, rooms] = await Promise.all([api.users(token, query), api.groups(token)])
      setUsers(people)
      setGroups(rooms)
    } catch (error) { setToast(errorMessage(error)) }
  }, [token])

  useEffect(() => {
    const id = window.setTimeout(() => loadContacts(search), 250)
    return () => window.clearTimeout(id)
  }, [loadContacts, search])

  useEffect(() => {
    const interval = window.setInterval(() => loadContacts(search), 30_000)
    return () => window.clearInterval(interval)
  }, [loadContacts, search])

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
        if (event.type !== 'message') return
        const message = event.data as Message
        const active = selectedRef.current
        const matches = active && (
          (active.kind === 'group' && message.group_id === active.id) ||
          (active.kind === 'direct' && message.group_id === null && (message.sender === active.name || message.recipient === active.name))
        )
        if (matches) setMessages(previous => previous.some(item => item.id === message.id) ? previous : [...previous, message])
        else {
          const sender = usersRef.current.find(item => item.username === message.sender)
          const key = message.group_id ? `group:${message.group_id}` : `direct:${sender?.id ?? message.sender}`
          setUnread(previous => ({ ...previous, [key]: (previous[key] ?? 0) + 1 }))
        }
      }
    }
    connect()
    return () => { closed = true; window.clearTimeout(reconnectTimer); socketRef.current?.close() }
  }, [token])

  async function selectChat(chat: ChatTarget) {
    setSelected(chat)
    setShowMobileSidebar(false)
    setUnread(previous => ({ ...previous, [chatKey(chat)]: 0 }))
    setLoadingChat(true)
    try {
      const history = chat.kind === 'direct' ? await api.directHistory(token, chat.name) : await api.groupHistory(token, chat.id)
      setMessages(history)
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
      if (fileInput.current) fileInput.current.value = ''
    } catch (error) { setToast(errorMessage(error)) }
    finally { setSending(false) }
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
      <aside className={`sidebar ${showMobileSidebar ? 'mobile-open' : ''}`}>
        <header className="sidebar-header">
          <div className="mini-logo">W<span>3</span></div>
          <div><strong>W3SHUŌ</strong><small><i className={socketOnline ? 'online' : ''} />{socketOnline ? 'Connected' : 'Reconnecting…'}</small></div>
          <button className="icon-button" onClick={onLogout} title="Log out"><LogOut size={18} /></button>
        </header>
        <div className="search-box"><Search size={17} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search people" /></div>
        <div className="sidebar-scroll">
          <div className="section-title"><span>MESSAGES</span><span>{users.length}</span></div>
          <div className="chat-list">
            {users.map(user => {
              const target: ChatTarget = { kind: 'direct', id: user.id, name: user.username, online: user.online, lastSeen: user.last_seen }
              const count = unread[chatKey(target)] ?? 0
              return <button key={user.id} className={selected?.kind === 'direct' && selected.id === user.id ? 'active' : ''} onClick={() => selectChat(target)}>
                <span className="avatar">{avatar(user.username)}<i className={user.online ? 'online' : ''} /></span>
                <span className="chat-label"><strong>{user.username}</strong><small>{user.online ? 'Online' : user.last_seen ? 'Offline' : 'Start a conversation'}</small></span>
                {count > 0 && <b className="unread">{count}</b>}
              </button>
            })}
            {!users.length && <p className="empty-list">No people found.</p>}
          </div>
          <div className="section-title"><span>GROUPS</span><button onClick={() => setShowGroupModal(true)} title="Create group"><Plus size={15} /></button></div>
          <div className="chat-list">
            {groups.map(group => {
              const target: ChatTarget = { kind: 'group', id: group.id, name: group.name, memberCount: group.member_count }
              const count = unread[chatKey(target)] ?? 0
              return <button key={group.id} className={selected?.kind === 'group' && selected.id === group.id ? 'active' : ''} onClick={() => selectChat(target)}>
                <span className="avatar group"><Hash size={20} /></span>
                <span className="chat-label"><strong>{group.name}</strong><small>{group.member_count} members</small></span>
                {count > 0 && <b className="unread">{count}</b>}
              </button>
            })}
          </div>
        </div>
        <footer className="profile-card"><span className="avatar">{avatar(currentUser.username)}<i className="online" /></span><span><strong>{currentUser.username}</strong><small>Available</small></span><MoreVertical size={18} /></footer>
      </aside>

      <section className={`conversation ${selected ? 'has-chat' : ''}`}>
        {!selected ? <EmptyChat onOpenSidebar={() => setShowMobileSidebar(true)} /> : <>
          <header className="conversation-header">
            <button className="mobile-back" onClick={() => setShowMobileSidebar(true)}><ArrowLeft size={20} /></button>
            <span className={`avatar ${selected.kind === 'group' ? 'group' : ''}`}>{selected.kind === 'group' ? <UsersRound size={20} /> : avatar(selected.name)}{selected.kind === 'direct' && <i className={selected.online ? 'online' : ''} />}</span>
            <div><strong>{selected.name}</strong><small>{selected.kind === 'group' ? `${selected.memberCount} members` : selected.online ? 'Online now' : 'Offline'}</small></div>
            <span className="header-spacer" />
            {selected.kind === 'direct' && <>
              <button className="icon-button" disabled={!selected.online} onClick={() => calls.startCall(selected.name, 'audio')} title={selected.online ? 'Audio call' : 'User is offline'}><Mic size={19} /></button>
              <button className="icon-button" disabled={!selected.online} onClick={() => calls.startCall(selected.name, 'video')} title={selected.online ? 'Video call' : 'User is offline'}><Video size={20} /></button>
            </>}
          </header>
          <div ref={messageAreaRef} className="message-area">
            {loadingChat ? <div className="message-loader"><i /><span>Loading conversation…</span></div> : !messages.length ? <div className="conversation-empty"><MessageCircleMore size={38} /><h3>No messages yet</h3><p>Start the conversation. A suspiciously empty chat deserves fixing.</p></div> : messages.map((message, index) => {
              const mine = message.sender === currentUser.username
              const showSender = selected.kind === 'group' && !mine && messages[index - 1]?.sender !== message.sender
              return <article key={message.id} className={`message-row ${mine ? 'mine' : ''}`}>
                {!mine && selected.kind === 'group' && <span className="message-avatar">{avatar(message.sender)}</span>}
                <div className="bubble-wrap">{showSender && <small className="sender-name">{message.sender}</small>}<div className="message-bubble">
                  {message.content && <p>{message.content}</p>}
                  {message.media_id && <button className="attachment" onClick={() => downloadAttachment(message.media_id!)}><ArrowDownToLine size={18} /><span><strong>Attachment</strong><small>Click to download</small></span></button>}
                  <time>{displayTime(message.created_at)}</time>
                </div></div>
              </article>
            })}
            <div aria-hidden="true" />
          </div>
          <form className="composer" onSubmit={sendMessage}>
            {file && <div className="selected-file"><Paperclip size={15} /><span>{file.name}</span><button type="button" onClick={() => setFile(null)}><X size={15} /></button></div>}
            <div className="composer-row">
              <input ref={fileInput} type="file" hidden onChange={event => setFile(event.target.files?.[0] ?? null)} />
              <button type="button" className="icon-button" onClick={() => fileInput.current?.click()} title="Attach file"><Paperclip size={20} /></button>
              <textarea value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder={`Message ${selected.name}`} rows={1} />
              <button type="button" className="icon-button decorative" title="Emoji"><Smile size={20} /></button>
              <button className="send-button" disabled={sending || (!text.trim() && !file)} title="Send"><Send size={19} /></button>
            </div>
          </form>
        </>}
      </section>

      {showGroupModal && <CreateGroupModal users={users} token={token} onClose={() => setShowGroupModal(false)} onCreated={() => { setShowGroupModal(false); loadContacts(search) }} onError={setToast} />}
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