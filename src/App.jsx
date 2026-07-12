import { useCallback, useEffect, useRef, useState } from 'react'
import DS160IsraelForm from './DS160IsraelForm.jsx'
import FormLanding from './FormLanding.jsx'
import LoginPage from './LoginPage.jsx'
import MiniFormGuest from './MiniFormGuest.jsx'
import SessionExpiryGuard from './SessionExpiryGuard.jsx'
import { generateFormUUID } from './lib/formId.js'
import { listFormBlobsFromApi, fetchFormBlobPayload } from './lib/formBlob.js'
import { isAuthenticated, clearToken } from './lib/auth.js'

/** Extract UUID from a blob pathname like forms/שם_שם_<uuid>.json */
function extractUUIDFromPathname(pathname) {
  if (!pathname) return null
  const uuidRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i
  const m = pathname.match(uuidRe)
  return m ? m[1] : null
}

/** Parse /forms/<id> from a URL pathname, return id or null. */
function parseFormRoute(path) {
  const m = path.match(/^\/forms\/([a-zA-Z0-9_-]+)$/)
  return m ? m[1] : null
}

/** Parse /fill/<token> from a URL pathname, return token or null. */
function parseFillRoute(path) {
  const m = path.match(/^\/fill\/([a-zA-Z0-9_-]+)$/)
  return m ? m[1] : null
}

export default function App() {
  const [screen, setScreen] = useState('loading')
  const [formMountKey, setFormMountKey] = useState(0)
  const [loadedBlob, setLoadedBlob] = useState(null)
  const [loadedBlobKey, setLoadedBlobKey] = useState(null)
  const [formUUID, setFormUUID] = useState(null)
  const [guestToken, setGuestToken] = useState(null)
  const didInitRef = useRef(false)

  // On mount: determine which screen to show based on URL + auth state
  useEffect(() => {
    if (didInitRef.current) return
    didInitRef.current = true

    const path = window.location.pathname

    // /login — always public
    if (path === '/login') {
      setScreen('login')
      return
    }

    // /fill/<token> — guest mini-form, always public
    const fillToken = parseFillRoute(path)
    if (fillToken) {
      setGuestToken(fillToken)
      setScreen('fill')
      return
    }

    // All other routes require authentication
    if (!isAuthenticated()) {
      window.history.replaceState({}, '', '/login')
      setScreen('login')
      return
    }

    // /forms/<id> — load form from blob
    const formId = parseFormRoute(path)
    if (formId) {
      ;(async () => {
        try {
          const data = await listFormBlobsFromApi()
          const found = Array.isArray(data.forms)
            ? data.forms.find((f) => f.pathname.includes(`_${formId}.`) || f.formId === formId)
            : null

          if (found) {
            const { payload } = await fetchFormBlobPayload(found.pathname)
            setLoadedBlob(payload)
            setLoadedBlobKey(found.pathname)
            setFormUUID(formId)
            setFormMountKey((k) => k + 1)
            setScreen('form')
          } else {
            setFormUUID(formId)
            setFormMountKey((k) => k + 1)
            setScreen('form')
          }
        } catch {
          setScreen('landing')
        }
      })()
      return
    }

    // Default: landing
    setScreen('landing')
  }, [])

  const handleLogin = useCallback(() => {
    setScreen('landing')
    window.history.replaceState({}, '', '/')
  }, [])

  const handleLogout = useCallback(() => {
    clearToken()
    window.history.replaceState({}, '', '/login')
    setScreen('login')
  }, [])

  const openNewForm = useCallback(() => {
    const uuid = generateFormUUID()
    setLoadedBlob(null)
    setLoadedBlobKey(null)
    setFormUUID(uuid)
    setFormMountKey((k) => k + 1)
    window.history.pushState({}, '', `/forms/${uuid}`)
    setScreen('form')
  }, [])

  const openFormFromBlob = useCallback((pathname, payload) => {
    const uuid =
      (typeof payload?.data?.formUUID === 'string' && payload.data.formUUID.trim()
        ? payload.data.formUUID.trim()
        : null) ||
      extractUUIDFromPathname(pathname) ||
      (typeof payload?.formId === 'string' && payload.formId.trim() ? payload.formId.trim() : null)

    setLoadedBlob(payload)
    setLoadedBlobKey(pathname)
    setFormUUID(uuid)
    setFormMountKey((k) => k + 1)
    if (uuid) {
      window.history.pushState({}, '', `/forms/${uuid}`)
    }
    setScreen('form')
  }, [])

  const goLanding = useCallback(() => {
    setScreen('landing')
    setLoadedBlob(null)
    setLoadedBlobKey(null)
    setFormUUID(null)
    window.history.pushState({}, '', '/')
  }, [])

  // Handle browser back/forward
  useEffect(() => {
    const handler = () => {
      const path = window.location.pathname

      const fillToken = parseFillRoute(path)
      if (fillToken) {
        setGuestToken(fillToken)
        setScreen('fill')
        return
      }

      if (path === '/login') {
        setScreen('login')
        return
      }

      if (!isAuthenticated()) {
        window.history.replaceState({}, '', '/login')
        setScreen('login')
        return
      }

      const formId = parseFormRoute(path)
      if (!formId) setScreen('landing')
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  if (screen === 'loading') {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <p className="text-gray-500 text-sm">טוען…</p>
      </div>
    )
  }

  if (screen === 'login') {
    return <LoginPage onLogin={handleLogin} />
  }

  if (screen === 'fill') {
    return <MiniFormGuest guestToken={guestToken} />
  }

  if (screen === 'landing') {
    return (
      <>
        <SessionExpiryGuard onExpiredLogout={handleLogout} />
        <FormLanding
          onNewForm={openNewForm}
          onOpenForm={openFormFromBlob}
          onLogout={handleLogout}
        />
      </>
    )
  }

  return (
    <>
      <SessionExpiryGuard onExpiredLogout={handleLogout} />
      <DS160IsraelForm
        key={formMountKey}
        initialBlob={loadedBlob}
        initialBlobKey={loadedBlobKey}
        formUUID={formUUID}
        onExitToHome={goLanding}
      />
    </>
  )
}
