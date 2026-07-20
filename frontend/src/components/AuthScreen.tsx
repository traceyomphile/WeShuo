import { useEffect, useState } from 'react'
import type { SubmitEvent } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { api } from '../api'
import { errorMessage } from '../utils/errors'
import type { AuthUser } from '../types'

interface Props { onAuthenticated: (token: string, user: AuthUser) => void }

export default function AuthScreen({ onAuthenticated }: Props) {
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [busy, setBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null)

  useEffect(() => { 
    const timer = window.setTimeout(() => {
      setReady(true)
    }, 4000)
    
    return () => window.clearTimeout(timer) 
  }, [])

  useEffect(() => {
    if (!notice || notice.type === 'success') return
    const id = window.setTimeout(() => setNotice(null), 2200)
    return () => clearTimeout(id)
  }, [notice])

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setNotice(null)
    const data = new FormData(event.currentTarget)
    const username = String(data.get('username') ?? '').trim()
    const password = String(data.get('password') ?? '')
    if (mode === 'signup' && password !== String(data.get('confirmPassword') ?? '')) {
      setNotice({ type: 'error', text: 'Passwords do not match.' })
      return
    }
    setBusy(true)
    try {
      const result = mode === 'login' ? await api.login(username, password) : await api.register(username, password)
      setNotice({ type: 'success', text: mode === 'login' ? 'Welcome back.' : 'Account created.' })
      window.setTimeout(() => onAuthenticated(result.access_token, result.user), 350)
    } catch (error) {
      setNotice({ type: 'error', text: errorMessage(error) })
    } finally { setBusy(false) }
  }

  return (
    <div className={`auth-page ${ready ? 'is-ready' : ''}`}>
      <section className="welcome-panel">
        <div className="hero">
          <div className="welcome-mark" role="img" aria-label="W3SHUŌ">
            <svg className="welcome-bubble" viewBox="0 0 1000 650" aria-hidden="true">
              <defs>
                <filter id="bubbleGlow" x="-30%" y="-30%" width="160%" height="160%">
                  <feGaussianBlur stdDeviation="11" result="wideGlow" />
                  <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="nearGlow" />
                  <feMerge><feMergeNode in="wideGlow" /><feMergeNode in="nearGlow" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <g filter="url(#bubbleGlow)">
                <path className="bubble-stroke bubble-top" pathLength="1" d="M170 120H730C821 120 879 153 920 215" />
                <path className="bubble-stroke bubble-left" pathLength="1" d="M125 140C72 168 45 218 45 285V395C45 422 49 445 60 465" />
                <path className="bubble-stroke bubble-tail" pathLength="1" d="M140 530L220 565L185 640C264 600 323 563 365 530H700" />
              </g>
            </svg>
            <h1 className="welcome-logo" aria-hidden="true">
              <span className="logo-letters">W 3 S H U</span><span className="logo-final-o"><span className="logo-o-glyph">Ō</span><b>说</b></span>
            </h1>
          </div>
          <div className="welcome-divider" />
          <p>connect <b>•</b> chat <b>•</b> call</p>
          <div className="loading-dots"><i /><i /><i /></div>
        </div>
      </section>

      <section className="auth-panel">
        <main className="auth-card active">
          <h2 key={mode} className="auth-title">
            {mode === 'login' ? 'LOGIN' : 'SIGN UP'}
          </h2>
          <form key={mode} className="auth-form" onSubmit={submit}>
            <label htmlFor="username">Username</label>
            <input id="username" name="username" placeholder={mode === 'login' ? 'username' : 'enter username'} minLength={3} maxLength={30} autoComplete="username" required />
            <label htmlFor="password">Password</label>
            <div className="password-field">
              <input id="password" name="password" type={showPassword ? 'text' : 'password'} placeholder="*********" minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
              <button type="button" className="password-toggle" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button>
            </div>
            {mode === 'signup' && <>
              <label htmlFor="confirmPassword">Confirm Password</label>
              <div className="password-field">
                <input id="confirmPassword" name="confirmPassword" type={showConfirmPassword ? 'text' : 'password'} placeholder="confirm password" minLength={8} autoComplete="new-password" required />
                <button type="button" className="password-toggle" onClick={() => setShowConfirmPassword(value => !value)} aria-label={showConfirmPassword ? 'Hide confirmation password' : 'Show confirmation password'} title={showConfirmPassword ? 'Hide confirmation password' : 'Show confirmation password'}>{showConfirmPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button>
              </div>
            </>}
            <button type="submit" disabled={busy}>{busy ? 'CONNECTING…' : mode === 'login' ? 'LOGIN' : 'REGISTER'}</button>
            <button type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setShowPassword(false); setShowConfirmPassword(false); setNotice(null) }}>{mode === 'login' ? 'SIGNUP' : 'BACK TO LOGIN'}</button>
          </form>
        </main>
      </section>
      <div className={`popup-overlay ${notice ? 'show' : ''}`} role="alert">
        <div className="popup-box"><h2>{notice?.type === 'success' ? 'Success' : 'Unable to continue'}</h2><p>{notice?.text}</p></div>
      </div>
    </div>
  )
}