import { useCallback, useState } from 'react'
import DS160IsraelForm from './DS160IsraelForm.jsx'
import FormLanding from './FormLanding.jsx'

export default function App() {
  /** Landing first: create new form or pick from Blob list (`FormLanding`). */
  const [screen, setScreen] = useState('landing')
  const [formMountKey, setFormMountKey] = useState(0)
  const [loadedBlob, setLoadedBlob] = useState(null)
  const [loadedBlobKey, setLoadedBlobKey] = useState(null)

  const openNewForm = useCallback(() => {
    setLoadedBlob(null)
    setLoadedBlobKey(null)
    setFormMountKey((k) => k + 1)
    setScreen('form')
  }, [])

  const openFormFromBlob = useCallback((pathname, payload) => {
    setLoadedBlob(payload)
    setLoadedBlobKey(pathname)
    setFormMountKey((k) => k + 1)
    setScreen('form')
  }, [])

  const goLanding = useCallback(() => {
    setScreen('landing')
    setLoadedBlob(null)
    setLoadedBlobKey(null)
  }, [])

  if (screen === 'landing') {
    return <FormLanding onNewForm={openNewForm} onOpenForm={openFormFromBlob} />
  }

  return (
    <DS160IsraelForm
      key={formMountKey}
      initialBlob={loadedBlob}
      initialBlobKey={loadedBlobKey}
      onExitToHome={goLanding}
    />
  )
}
