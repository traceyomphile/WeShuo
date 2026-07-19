import { useEffect, useState } from 'react'
import type { SubmitEvent } from 'react'
import { ArrowLeft, Eye, EyeOff, LockKeyhole, UserRound } from 'lucide-react'
import { api } from '../api'
import { errorMessage } from '../utils/errors'
import type { AuthUser } from '../types'

interface Props { onAuthenticated: (token: string, user: AuthUser) => void }

export default function AuthScreen({ onAuthenticated }: Props) {
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null)

  useEffect(() => { const id = window.setTimeout(() => setReady(true), 2600); return () => clearTimeout(id) }, [])

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
          <h1 className="welcome-logo"><span>W</span><span className="three">3</span><span>SHUŌ</span></h1>
          <div className="welcome-divider" />
          <p>connect <b>•</b> chat <b>•</b> call</p>
          <div className="loading-dots"><i /><i /><i /></div>
        </div>
      </section>

      <section className="auth-panel">
        <main className="auth-card">
          {mode === 'signup' && <button className="back-link" onClick={() => { setMode('login'); setNotice(null) }}><ArrowLeft size={17} /> Back</button>}
          <p className="eyebrow">SECURE CONNECTION</p>
          <h2>{mode === 'login' ? 'LOGIN' : 'SIGN UP'}</h2>
          <p className="auth-copy">{mode === 'login' ? 'Continue your conversations.' : 'Create your W3SHUŌ identity.'}</p>

          <form onSubmit={submit}>
            <label htmlFor="username">Username</label>
            <div className="field"><UserRound size={18} /><input id="username" name="username" placeholder="username" minLength={3} maxLength={30} autoComplete="username" required /></div>
            <label htmlFor="password">Password</label>
            <div className="field"><LockKeyhole size={18} /><input id="password" name="password" type={showPassword ? 'text' : 'password'} placeholder="••••••••" minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required /><button type="button" aria-label="Toggle password visibility" onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
            {mode === 'signup' && <><label htmlFor="confirmPassword">Confirm password</label><div className="field"><LockKeyhole size={18} /><input id="confirmPassword" name="confirmPassword" type={showPassword ? 'text' : 'password'} placeholder="••••••••" minLength={8} autoComplete="new-password" required /></div><small className="password-hint">Use uppercase, lowercase, a number and a special character.</small></>}
            {notice && <div role="alert" className={`form-notice ${notice.type}`}>{notice.text}</div>}
            <button className="primary-button" disabled={busy}>{busy ? 'CONNECTING…' : mode === 'login' ? 'LOGIN' : 'CREATE ACCOUNT'}</button>
          </form>
          {mode === 'login' && <button className="secondary-button" onClick={() => { setMode('signup'); setNotice(null) }}>CREATE AN ACCOUNT</button>}
        </main>
      </section>
    </div>
  )
}
