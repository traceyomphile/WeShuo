import { useEffect, useState } from 'react'
import { api } from './api'
import AuthScreen from './components/AuthScreen'
import ChatApp from './components/ChatApp'
import type { AuthUser } from './types'

const TOKEN_KEY = 'w3shuo_token'

export default function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [checking, setChecking] = useState(Boolean(token))

  useEffect(() => {
    if (!token) return
    api.me(token).then(setUser).catch(() => {
      sessionStorage.removeItem(TOKEN_KEY)
      setToken('')
    }).finally(() => setChecking(false))
  }, [token])

  function onAuthenticated(nextToken: string, nextUser: AuthUser) {
    sessionStorage.setItem(TOKEN_KEY, nextToken)
    setToken(nextToken)
    setUser(nextUser)
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY)
    setToken('')
    setUser(null)
  }

  if (checking) return <div className="boot-screen"><span className="brand-mark">W<span>3</span>SHUŌ</span><i /></div>
  if (!token || !user) return <AuthScreen onAuthenticated={onAuthenticated} />
  return <ChatApp token={token} currentUser={user} onLogout={logout} />
}

