import { useEffect, useState } from 'react'
import type { SubmitEvent } from 'react'
import { api } from '../api'
import { errorMessage } from '../utils/errors'
import type { AuthUser } from '../types'

interface Props { onAuthenticated: (token: string, user: AuthUser) => void }

export default function AuthScreen({ onAuthenticated }: Props) {
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null)

  useEffect(() => { const id = window.setTimeout(() => setReady(true), 4000); return () => clearTimeout(id) }, [])
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
          <h1 className="welcome-logo"><span>W</span><span className="three">3</span><span>SHUŌ</span></h1>
          <div className="welcome-divider" />
          <p>connect <b>•</b> chat <b>•</b> call</p>
          <div className="loading-dots"><i /><i /><i /></div>
        </div>
      </section>

      <section className="auth-panel">
        <main className="auth-card active">
          <h2 key={mode} className="auth-title">{mode === 'login' ? 'LOGIN' : 'SIGN UP'}</h2>
          <form key={mode} className="auth-form" onSubmit={submit}>
            <label htmlFor="username">Username</label>
            <input id="username" name="username" placeholder={mode === 'login' ? 'username' : 'enter username'} minLength={3} maxLength={30} autoComplete="username" required />
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" placeholder="*********" minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
            {mode === 'signup' && <><label htmlFor="confirmPassword">Confirm Password</label><input id="confirmPassword" name="confirmPassword" type="password" placeholder="confirm password" minLength={8} autoComplete="new-password" required /></>}
            <button type="submit" disabled={busy}>{busy ? 'CONNECTING…' : mode === 'login' ? 'LOGIN' : 'REGISTER'}</button>
            <button type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setNotice(null) }}>{mode === 'login' ? 'SIGNUP' : 'BACK TO LOGIN'}</button>
          </form>
        </main>
      </section>
      <div className={`popup-overlay ${notice ? 'show' : ''}`} role="alert">
        <div className="popup-box"><h2>{notice?.type === 'success' ? 'Success' : 'Unable to continue'}</h2><p>{notice?.text}</p></div>
      </div>
    </div>
  )
}
