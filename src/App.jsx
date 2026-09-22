import { useCallback, useEffect, useRef, useState } from 'react'
import AutofillMonitoring from './AutofillMonitoring.jsx'
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
  const [formOpen, setFormOpen] = useState(false)
  const [monitorOpen, setMonitorOpen] = useState(false)
  const [openingPathname, setOpeningPathname] = useState('')
  const [guestToken, setGuestToken] = useState(null)
  const didInitRef = useRef(false)
  const unsavedCheckRef = useRef(() => false)

  const bindUnsavedCheck = useCallback((fn) => {
    unsavedCheckRef.current = typeof fn === 'function' ? fn : () => false
  }, [])

  const confirmLeaveForm = useCallback(() => {
    if (!formOpen) return true
    if (!unsavedCheckRef.current()) return true
    return window.confirm('יש שינויים שלא נשמרו. להחליף טופס?')
  }, [formOpen])

  const applyLoadedForm = useCallback((pathname, payload, uuid) => {
    setLoadedBlob(payload)
    setLoadedBlobKey(pathname)
    setFormUUID(uuid)
    setFormMountKey((k) => k + 1)
    setFormOpen(true)
    setMonitorOpen(false)
    if (uuid) {
      window.history.pushState({}, '', `/forms/${uuid}`)
    }
  }, [])

  // On mount: determine which screen to show based on URL + auth state
  useEffect(() => {
    if (didInitRef.current) return
    didInitRef.current = true

    const path = window.location.pathname

    if (path === '/login') {
      setScreen('login')
      return
    }

    const fillToken = parseFillRoute(path)
    if (fillToken) {
      setGuestToken(fillToken)
      setScreen('fill')
      return
    }

    if (!isAuthenticated()) {
      window.history.replaceState({}, '', '/login')
      setScreen('login')
      return
    }

    const formId = parseFormRoute(path)
    if (formId) {
      setScreen('portal')
      setOpeningPathname(formId)
      ;(async () => {
        try {
          const data = await listFormBlobsFromApi()
          const found = Array.isArray(data.forms)
            ? data.forms.find((f) => f.pathname.includes(`_${formId}.`) || f.formId === formId)
            : null

          if (found) {
            const { payload } = await fetchFormBlobPayload(found.pathname)
            applyLoadedForm(found.pathname, payload, formId)
          } else {
            applyLoadedForm(null, null, formId)
          }
        } catch {
          setFormOpen(false)
        } finally {
          setOpeningPathname('')
        }
      })()
      return
    }

    setScreen('portal')
  }, [applyLoadedForm])

  const handleLogin = useCallback(() => {
    setScreen('portal')
    window.history.replaceState({}, '', '/')
  }, [])

  const handleLogout = useCallback(() => {
    clearToken()
    window.history.replaceState({}, '', '/login')
    setScreen('login')
  }, [])

  const openNewForm = useCallback(() => {
    const uuid = generateFormUUID()
    applyLoadedForm(null, null, uuid)
  }, [applyLoadedForm])

  const openFormFromBlob = useCallback((pathname, payload) => {
    const uuid =
      (typeof payload?.data?.formUUID === 'string' && payload.data.formUUID.trim()
        ? payload.data.formUUID.trim()
        : null) ||
      extractUUIDFromPathname(pathname) ||
      (typeof payload?.formId === 'string' && payload.formId.trim() ? payload.formId.trim() : null)

    applyLoadedForm(pathname, payload, uuid)
  }, [applyLoadedForm])

  const openMonitoring = useCallback(() => {
    if (monitorOpen) {
      setMonitorOpen(false)
      return
    }
    if (!confirmLeaveForm()) return
    setMonitorOpen(true)
  }, [monitorOpen, confirmLeaveForm])

  const clearSelectedForm = useCallback(() => {
    if (!confirmLeaveForm()) return
    setFormOpen(false)
    setLoadedBlob(null)
    setLoadedBlobKey(null)
    setFormUUID(null)
    unsavedCheckRef.current = () => false
    window.history.pushState({}, '', '/')
  }, [confirmLeaveForm])

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

      setScreen('portal')
      const formId = parseFormRoute(path)
      if (!formId) {
        setFormOpen(false)
        setLoadedBlob(null)
        setLoadedBlobKey(null)
        setFormUUID(null)
      }
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  if (screen === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100">
        <p className="text-sm text-gray-500">טוען…</p>
      </div>
    )
  }

  if (screen === 'login') {
    return <LoginPage onLogin={handleLogin} />
  }

  if (screen === 'fill') {
    return <MiniFormGuest guestToken={guestToken} />
  }

  return (
    <>
      <SessionExpiryGuard onExpiredLogout={handleLogout} />
      <div dir="rtl" className="min-h-screen bg-gray-100 font-sans md:flex">
        <aside
          className={`flex flex-col overflow-hidden border-b border-gray-200 bg-white md:sticky md:top-0 md:h-screen md:w-[22rem] md:shrink-0 md:border-b-0 md:border-s lg:w-[26rem] ${
            formOpen ? 'h-[42vh] md:h-screen' : 'min-h-[70vh] md:min-h-0'
          }`}
        >
          <FormLanding
            onNewForm={openNewForm}
            onOpenForm={openFormFromBlob}
            onLogout={handleLogout}
            selectedPathname={loadedBlobKey}
            onCanLeave={confirmLeaveForm}
            monitoringOpen={monitorOpen}
            onToggleMonitoring={openMonitoring}
          />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto md:h-screen">
          {monitorOpen ? (
            <AutofillMonitoring onBack={() => setMonitorOpen(false)} />
          ) : openingPathname && !formOpen ? (
            <div className="flex min-h-[40vh] items-center justify-center text-sm text-gray-500">
              טוען טופס…
            </div>
          ) : formOpen ? (
            <DS160IsraelForm
              key={formMountKey}
              initialBlob={loadedBlob}
              initialBlobKey={loadedBlobKey}
              formUUID={formUUID}
              onExitToHome={clearSelectedForm}
              onBindUnsavedCheck={bindUnsavedCheck}
            />
          ) : (
            <div className="flex min-h-[50vh] flex-col items-center justify-center gap-2 px-6 py-16 text-center text-gray-500 md:min-h-full">
              <p className="text-base font-medium text-gray-700">בחרו טופס מהרשימה</p>
              <p className="max-w-sm text-sm">
                הטופס נטען רק אחרי לחיצה על שם. במסך רחב הרשימה נשארת בצד ימין.
              </p>
            </div>
          )}
        </main>
      </div>
    </>
  )
}
