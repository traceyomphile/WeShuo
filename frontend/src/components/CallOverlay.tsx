import { useEffect, useRef } from 'react'
import { Mic, Phone, PhoneOff, Video } from 'lucide-react'
import type { CallKind } from '../types'

interface Props {
  call: { status: 'incoming' | 'calling' | 'connecting' | 'active'; peer: string; kind: CallKind }
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  onAccept: () => void
  onReject: () => void
  onEnd: () => void
}

export default function CallOverlay({ call, localStream, remoteStream, onAccept, onReject, onEnd }: Props) {
  const localVideo = useRef<HTMLVideoElement>(null)
  const remoteVideo = useRef<HTMLVideoElement>(null)
  const remoteAudio = useRef<HTMLAudioElement>(null)

  useEffect(() => { if (localVideo.current) localVideo.current.srcObject = localStream }, [localStream])
  useEffect(() => {
    if (remoteVideo.current) remoteVideo.current.srcObject = remoteStream
    if (remoteAudio.current) remoteAudio.current.srcObject = remoteStream
  }, [remoteStream])

  const label = call.status === 'incoming' ? `Incoming ${call.kind} call` : call.status === 'active' ? 'Connected' : call.status === 'calling' ? 'Calling…' : 'Connecting…'
  return (
    <div className="call-overlay">
      <div className={`call-stage ${call.kind}`}>
        {call.kind === 'video' && <>
          <video ref={remoteVideo} autoPlay playsInline className="remote-video" />
          <video ref={localVideo} autoPlay playsInline muted className="local-video" />
        </>}
        {call.kind === 'audio' && <div className="call-avatar"><span>{call.peer.slice(0, 2).toUpperCase()}</span><div className="audio-rings" /></div>}
        <audio ref={remoteAudio} autoPlay />
        <div className="call-info"><small>{label}</small><h2>{call.peer}</h2><p>{call.kind === 'video' ? <><Video size={16} /> Video call</> : <><Mic size={16} /> Audio call</>}</p></div>
        <div className="call-actions">
          {call.status === 'incoming' ? <>
            <button className="answer" onClick={onAccept} aria-label="Accept call"><Phone size={24} /></button>
            <button className="hangup" onClick={onReject} aria-label="Reject call"><PhoneOff size={24} /></button>
          </> : <button className="hangup" onClick={onEnd} aria-label="End call"><PhoneOff size={24} /></button>}
        </div>
      </div>
    </div>
  )
}
