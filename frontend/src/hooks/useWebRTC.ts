import { useCallback, useEffect, useRef, useState } from 'react'
import type { CallKind, SocketEvent } from '../types'

interface CallState {
  status: 'incoming' | 'calling' | 'connecting' | 'active'
  peer: string
  kind: CallKind
}

interface SignalData { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; kind?: CallKind }

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: import.meta.env.VITE_STUN_URL ?? 'stun:stun.l.google.com:19302' }]
  if (import.meta.env.VITE_TURN_URL) servers.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USERNAME,
    credential: import.meta.env.VITE_TURN_CREDENTIAL,
  })
  return servers
}

export function useWebRTC(sendSignal: (event: object) => void, onError: (message: string) => void) {
  const [call, setCall] = useState<CallState | null>(null)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const offerRef = useRef<RTCSessionDescriptionInit | null>(null)
  const candidateQueue = useRef<RTCIceCandidateInit[]>([])

  const cleanup = useCallback((notify = false) => {
    if (notify && call) sendSignal({ type: 'call_end', target: call.peer })
    peerRef.current?.close()
    peerRef.current = null
    localStream?.getTracks().forEach(track => track.stop())
    remoteStream?.getTracks().forEach(track => track.stop())
    setLocalStream(null)
    setRemoteStream(null)
    setCall(null)
    offerRef.current = null
    candidateQueue.current = []
  }, [call, localStream, remoteStream, sendSignal])

  const createPeer = useCallback(async (peer: string, kind: CallKind) => {
    const connection = new RTCPeerConnection({ iceServers: iceServers() })
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' })
    stream.getTracks().forEach(track => connection.addTrack(track, stream))
    connection.onicecandidate = event => {
      if (event.candidate) sendSignal({ type: 'ice_candidate', target: peer, data: { candidate: event.candidate.toJSON() } })
    }
    connection.ontrack = event => setRemoteStream(event.streams[0] ?? new MediaStream([event.track]))
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') setCall(current => current ? { ...current, status: 'active' } : current)
      if (['failed', 'closed'].includes(connection.connectionState)) cleanup(false)
    }
    peerRef.current = connection
    setLocalStream(stream)
    return connection
  }, [cleanup, sendSignal])

  const flushCandidates = useCallback(async () => {
    const connection = peerRef.current
    if (!connection?.remoteDescription) return
    for (const candidate of candidateQueue.current.splice(0)) await connection.addIceCandidate(candidate)
  }, [])

  const startCall = useCallback(async (peer: string, kind: CallKind) => {
    if (call) return
    setCall({ status: 'calling', peer, kind })
    try {
      const connection = await createPeer(peer, kind)
      const offer = await connection.createOffer()
      await connection.setLocalDescription(offer)
      sendSignal({ type: 'call_offer', target: peer, data: { sdp: offer, kind } })
    } catch (error) {
      cleanup(false)
      onError(error instanceof Error ? error.message : 'Camera or microphone permission was denied.')
    }
  }, [call, cleanup, createPeer, onError, sendSignal])

  const acceptCall = useCallback(async () => {
    if (!call || call.status !== 'incoming' || !offerRef.current) return
    setCall({ ...call, status: 'connecting' })
    try {
      const connection = await createPeer(call.peer, call.kind)
      await connection.setRemoteDescription(offerRef.current)
      await flushCandidates()
      const answer = await connection.createAnswer()
      await connection.setLocalDescription(answer)
      sendSignal({ type: 'call_answer', target: call.peer, data: { sdp: answer } })
    } catch (error) {
      cleanup(false)
      onError(error instanceof Error ? error.message : 'Could not answer the call.')
    }
  }, [call, cleanup, createPeer, flushCandidates, onError, sendSignal])

  const rejectCall = useCallback(() => {
    if (call) sendSignal({ type: 'call_reject', target: call.peer })
    cleanup(false)
  }, [call, cleanup, sendSignal])

  const handleSignal = useCallback(async (event: SocketEvent) => {
    const data = (event.data ?? {}) as SignalData
    if (!event.from) return
    try {
      if (event.type === 'call_offer' && data.sdp) {
        if (call) {
          sendSignal({ type: 'call_reject', target: event.from })
          return
        }
        offerRef.current = data.sdp
        setCall({ status: 'incoming', peer: event.from, kind: data.kind ?? 'audio' })
      } else if (event.type === 'call_answer' && data.sdp && peerRef.current) {
        await peerRef.current.setRemoteDescription(data.sdp)
        await flushCandidates()
        setCall(current => current ? { ...current, status: 'connecting' } : current)
      } else if (event.type === 'ice_candidate' && data.candidate) {
        if (peerRef.current?.remoteDescription) await peerRef.current.addIceCandidate(data.candidate)
        else candidateQueue.current.push(data.candidate)
      } else if (event.type === 'call_reject') {
        onError(`${event.from} declined the call.`)
        cleanup(false)
      } else if (event.type === 'call_end') cleanup(false)
    } catch { onError('The call connection failed.'); cleanup(false) }
  }, [call, cleanup, flushCandidates, onError, sendSignal])

  useEffect(() => () => {
    peerRef.current?.close()
    localStream?.getTracks().forEach(track => track.stop())
  }, [localStream])

  return { call, localStream, remoteStream, startCall, acceptCall, rejectCall, endCall: () => cleanup(true), handleSignal }
}
