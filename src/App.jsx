import { useCallback, useEffect, useRef, useState } from 'react'
import DS160IsraelForm from './DS160IsraelForm.jsx'
import FormLanding from './FormLanding.jsx'
import { generateFormUUID } from './lib/formId.js'
import { listFormBlobsFromApi, fetchFormBlobPayload } from './lib/formBlob.js'

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

export default function App() {
  const [screen, setScreen] = useState('loading')
  const [formMountKey, setFormMountKey] = useState(0)
  const [loadedBlob, setLoadedBlob] = useState(null)
  const [loadedBlobKey, setLoadedBlobKey] = useState(null)
  const [formUUID, setFormUUID] = useState(null)
  const didInitRef = useRef(false)

  // On mount: handle direct URL navigation to /forms/<id>
  useEffect(() => {
    if (didInitRef.current) return
    didInitRef.current = true

    const formId = parseFormRoute(window.location.pathname)
    if (!formId) {
      setScreen('landing')
      return
    }

    // Try to find and load the blob for this formId
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
          // Unknown id — start a fresh form with this UUID
          setFormUUID(formId)
          setFormMountKey((k) => k + 1)
          setScreen('form')
        }
      } catch {
        // Fall back to landing on error
        setScreen('landing')
      }
    })()
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
    // Prefer UUID stored in form data, then extract from pathname, then fall back to formId field
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
      const formId = parseFormRoute(window.location.pathname)
      if (!formId) {
        setScreen('landing')
      }
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

  if (screen === 'landing') {
    return <FormLanding onNewForm={openNewForm} onOpenForm={openFormFromBlob} />
  }

  return (
    <DS160IsraelForm
      key={formMountKey}
      initialBlob={loadedBlob}
      initialBlobKey={loadedBlobKey}
      formUUID={formUUID}
      onExitToHome={goLanding}
    />
  )
}
