import { useState } from 'react'
import CopyFromFormPicker from './CopyFromFormPicker.jsx'
import { applySectionValues, COPYABLE_SECTIONS } from './lib/copyFromFormSections.js'

/**
 * Drop-in control: "העתק מטופס אחר" + modal + apply into react-hook-form.
 *
 * @param {{
 *   sectionId: string,
 *   setValue: (name: string, value: unknown, opts?: object) => void,
 *   excludePathname?: string | null,
 *   excludeFormId?: string | null,
 *   onCopied?: (meta: { pathname: string, displayName: string }, values: Record<string, unknown>) => void,
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
        className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold text-teal-800 border border-teal-600 bg-teal-50 px-2.5 py-1.5 rounded-md hover:bg-teal-100 transition"
      >
        <span aria-hidden>📋</span>
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
          onCopied?.(meta, values)
        }}
      />
    </div>
  )
}

/**
 * Section title row with copy button on the left (RTL).
 *
 * @param {{
 *   as?: 'h2' | 'h3' | 'p',
 *   title: React.ReactNode,
 *   titleClassName?: string,
 *   sectionId: string,
 *   setValue: (name: string, value: unknown, opts?: object) => void,
 *   excludePathname?: string | null,
 *   excludeFormId?: string | null,
 *   onCopied?: (meta: { pathname: string, displayName: string }, values: Record<string, unknown>) => void,
 *   wrapClassName?: string,
 * }} props
 */
export function SectionCopyHeader({
  as: Tag = 'h2',
  title,
  titleClassName,
  sectionId,
  setValue,
  excludePathname,
  excludeFormId,
  onCopied,
  wrapClassName = '',
}) {
  const defaultTitleClass =
    Tag === 'h2'
      ? 'text-2xl font-bold text-gray-800'
      : Tag === 'h3'
        ? 'font-bold text-lg text-gray-800'
        : 'text-sm font-semibold text-gray-700'

  return (
    <div
      className={`flex items-start justify-between gap-3 ${Tag === 'h2' ? 'border-b pb-2' : ''} ${wrapClassName}`}
    >
      <Tag className={`${titleClassName || defaultTitleClass} pt-0.5`}>{title}</Tag>
      <CopyFromFormButton
        sectionId={sectionId}
        setValue={setValue}
        excludePathname={excludePathname}
        excludeFormId={excludeFormId}
        onCopied={onCopied}
      />
    </div>
  )
}
