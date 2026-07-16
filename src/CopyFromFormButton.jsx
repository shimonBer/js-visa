import { useState } from 'react'
import CopyFromFormPicker from './CopyFromFormPicker.jsx'
import { applySectionValues, COPYABLE_SECTIONS } from './lib/copyFromFormSections.js'

/**
 * Drop-in control: "העתק מטופס אחר" + modal + apply into react-hook-form.
 * Place next to any section title; pass a registered sectionId from COPYABLE_SECTIONS.
 *
 * @param {{
 *   sectionId: string,
 *   setValue: (name: string, value: unknown, opts?: object) => void,
 *   excludePathname?: string | null,
 *   excludeFormId?: string | null,
 *   onCopied?: (meta: { pathname: string, displayName: string }) => void,
 *   className?: string,
 * }} props
 */
export default function CopyFromFormButton({
  sectionId,
  setValue,
  excludePathname,
  excludeFormId,
  onCopied,
  className = '',
}) {
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState('')

  if (!COPYABLE_SECTIONS[sectionId]) return null

  return (
    <div className={`flex flex-col items-end gap-1 ${className}`}>
      <button
        type="button"
        onClick={() => {
          setNotice('')
          setOpen(true)
        }}
        className="shrink-0 text-xs font-semibold text-blue-700 border border-blue-600 bg-white px-2.5 py-1.5 rounded-md hover:bg-blue-50 transition"
      >
        העתק מטופס אחר
      </button>
      {notice && (
        <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-md px-2 py-1 max-w-[14rem] text-right">
          {notice}
        </p>
      )}
      <CopyFromFormPicker
        open={open}
        onClose={() => setOpen(false)}
        sectionId={sectionId}
        excludePathname={excludePathname}
        excludeFormId={excludeFormId}
        onCopy={(values, meta) => {
          applySectionValues(setValue, values)
          setNotice(`הועתק מטופס: ${meta.displayName || 'טופס אחר'}`)
          onCopied?.(meta)
        }}
      />
    </div>
  )
}
