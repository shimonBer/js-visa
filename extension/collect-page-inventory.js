/**
 * Browser-side DS-160 field inventory. Runs in page.evaluate() and in the
 * Chrome extension content script. Must not import other modules.
 */
var FORM_PREFIX = 'ctl00_SiteContentPlaceHolder_FormView1_'
var LARGE_SELECT_THRESHOLD = 50

function collectPageInventory({
  prefix = 'ctl00_SiteContentPlaceHolder_FormView1_',
  largeThreshold = 50,
} = {}) {
  // ─── helpers ────────────────────────────────────────────────────────────

  function strip(id) {
    return typeof id === 'string' && id.startsWith(prefix)
      ? id.slice(prefix.length)
      : (id || '')
  }

  function isVisible(el) {
    if (!el) return false
    // offsetParent is null for display:none; also check visibility
    if (el.offsetParent === null) {
      const s = window.getComputedStyle(el)
      if (s.position !== 'fixed' && s.position !== 'absolute') return false
    }
    const s = window.getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
  }

  function hasPostback(el) {
    if (!el) return false
    const attrs = ['onclick', 'onchange', 'onfocus', 'onblur']
    return attrs.some((a) => {
      const v = el.getAttribute(a) || ''
      return v.includes('__doPostBack') || v.includes('WebForm_DoPostBackWithOptions')
    })
  }

  /** Parse 1-based occurrence from repeater IDs like dtlXxx_ctl01_tbxField */
  function parseRow(id) {
    const m = (id || '').match(/_ctl(\d{2})_/)
    return m ? parseInt(m[1], 10) + 1 : null
  }

  /** Hash fields+values for cheap diffing — djb2 */
  function djb2(str) {
    let h = 5381
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h) ^ str.charCodeAt(i)
      h = h >>> 0
    }
    return h.toString(36)
  }

  /** Find the <label> text that is FOR a given element id */
  function labelFor(id) {
    const lbl = document.querySelector(`label[for="${id}"]`)
    return lbl ? lbl.textContent.replace(/\s+/g, ' ').trim() : ''
  }

  /**
   * Reduce a control id to its semantic core so a field and its gating
   * checkbox can be compared: tbxAPP_SSN1 → APPSSN1, cbexAPP_SSN_NA → APPSSN.
   */
  function gateCore(id) {
    return strip(id)
      .replace(/_ctl\d+_/g, '_')
      .toUpperCase()
      .replace(/^(?:DT[LRI]|DL)/, '')
      .replace(/TBX|CBEX|CBX|DDL|RBL|TB/g, '')
      .replace(/_/g, '')
      .replace(/(?:NAIND|UNKIND|UNK|NA)$/, '')
  }

  /**
   * Find the "Does Not Apply" / "Do Not Know" checkbox that gates an element.
   *
   * The container search alone is too loose: on Personal 1 the birth country
   * and birth state/province share a container, so the country would pick up
   * the state's checkbox and an N/A country would tick the wrong box. Require
   * the two ids to describe the same field, which still allows one checkbox to
   * gate several inputs (the three U.S. SSN boxes).
   */
  function findDnaCbx(el) {
    // One shared "Do Not Know" checkbox covers both U.S. contact person name
    // inputs. They sit in nested .field divs, so the container search below
    // never sees the checkbox (which lives in the outer field-group).
    if (/US_POC_(SURNAME|GIVEN_NAME)/i.test(el.id || '')) {
      const nameNa = document.querySelector('input[type="checkbox"][id$="cbxUS_POC_NAME_NA"]')
      if (nameNa && isVisible(nameNa)) return strip(nameNa.id)
    }

    const container = el.closest('.field, .field-group, td, tr') || el.parentElement
    if (!container) return null
    const candidates = container.querySelectorAll(
      'input[type="checkbox"][id*="cbex"][id*="NA"],' +
      'input[type="checkbox"][id*="cbx"][id*="NA"],' +
      'input[type="checkbox"][id*="Cbx"][id*="NA"]',
    )
    const fieldCore = gateCore(el.id)
    for (const cbx of candidates) {
      if (!isVisible(cbx)) continue
      const cbxCore = gateCore(cbx.id)
      if (!fieldCore || !cbxCore) continue
      if (fieldCore.startsWith(cbxCore) || cbxCore.startsWith(fieldCore)) {
        return strip(cbx.id)
      }
    }
    return null
  }

  /** True if element is inside a div.date (date-sub-control, handled by executeAction) */
  function insideDateDiv(el) {
    return Boolean(el.closest('div.date'))
  }

  /** True if id looks like an individual date part (Day/Month/Year sub-control) */
  function isDatePart(id) {
    return /(?:Day|Month|Year)$/.test(id) && (id.includes('DOB') || id.includes('Issu') || id.includes('Exp') || id.includes('Arriv') || id.includes('From') || id.includes('To') || id.includes('Lost') || id.includes('Date') || id.includes('Serv') || id.includes('Atten'))
  }

  // ─── collect fields ──────────────────────────────────────────────────────

  const fields = []
  const seenRefs = new Set()

  // ── 1. Radio groups (rbl* tables) ────────────────────────────────────────
  const radioTables = document.querySelectorAll('table[id*="FormView1"][id*="rbl"]')
  for (const tbl of radioTables) {
    if (!isVisible(tbl)) continue
    const ref = strip(tbl.id)
    if (seenRefs.has(ref)) continue

    // Question label (points to the table)
    const lbl = labelFor(tbl.id)

    // triggersPostback if any radio in the group has doPostBack
    const allRadios = Array.from(tbl.querySelectorAll('input[type="radio"]'))
    const triggersPostback = allRadios.some(hasPostback)

    // Current value — DS-160 radios use value="" (not "Y"/"N"), so detect
    // the checked state from the paired label text.
    let value = ''
    for (const radio of allRadios) {
      if (!radio.checked) continue
      const lbl2 = document.querySelector(`label[for="${radio.id}"]`)
      const txt = (lbl2 ? lbl2.textContent : radio.parentElement?.textContent || '').trim().toLowerCase()
      if (txt === 'yes') { value = 'Yes'; break }
      if (txt === 'no')  { value = 'No';  break }
      // Fallback: original Y/N value attribute
      if (radio.value === 'Y' || radio.value === 'y') { value = 'Yes'; break }
      if (radio.value === 'N' || radio.value === 'n') { value = 'No';  break }
    }
    // Final fallback: legacy attribute-based detection
    if (!value) {
      const chkY = tbl.querySelector('input[type="radio"][value="Y"]:checked, input[type="radio"][value="y"]:checked')
      const chkN = tbl.querySelector('input[type="radio"][value="N"]:checked, input[type="radio"][value="n"]:checked')
      if (chkY) value = 'Yes'
      else if (chkN) value = 'No'
    }

    // Validator
    const container = tbl.closest('.field, .field-group, td, tr') || tbl.parentElement
    const hasVal = container
      ? Boolean(container.querySelector('[id*="customVal"], [id*="CustomVal"], [id*="csv"]'))
      : false

    seenRefs.add(ref)
    fields.push({
      ref,
      kind: 'radio',
      label: lbl,
      value,
      options: ['Yes', 'No'],
      required: hasVal,
      disabled: false,
      dnaCbxRef: null,
      row: parseRow(tbl.id),
      triggersPostback,
    })
  }

  // ── 2. Date groups (Day + Month + Year triplets) ──────────────────────────
  //    DS-160 splits every date into three controls. Anchor on the Day
  //    control: div.date wraps some dates (passport issuance) but not others
  //    (passport expiry), and only the applicant's own DOB has a real
  //    <label for>. The sub-controls are skipped in pass 3 via isDatePart().
  const byId = (id) => document.getElementById(prefix + id)
  for (const dayEl of document.querySelectorAll('select[id*="Day"], input[id*="Day"]')) {
    if (!dayEl.id || !dayEl.id.includes('FormView')) continue
    if (!isVisible(dayEl)) continue

    // Split the repeater path from the control name so both are preserved:
    // dtlPrevEduc_ctl00_ddlSchoolFromDay → path "dtlPrevEduc_ctl00_",
    // name "SchoolFrom".
    const stripped = strip(dayEl.id)
    const split = stripped.match(/^(.*_ctl\d+_)?(?:ddl|tbx)?(.+?)Day$/)
    if (!split) continue
    const path = split[1] || ''
    const name = split[2]
    const base = path + name
    if (!name || seenRefs.has(base)) continue

    // Month always mirrors the Day id. Year usually does too, but passport
    // drops the "_DTE" segment: ddlPPT_ISSUED_DTEDay → tbxPPT_ISSUEDYear.
    const shortName = name.replace(/_DTE$/, '')
    const monthEl = byId(`${path}ddl${name}Month`) || byId(`${path}tbx${name}Month`)
    const yearEl =
      byId(`${path}tbx${name}Year`) || byId(`${path}ddl${name}Year`) ||
      byId(`${path}tbx${shortName}Year`) || byId(`${path}ddl${shortName}Year`)
    if (!monthEl || !yearEl) continue

    const container =
      dayEl.closest('.field, .field-group, td, tr') || dayEl.parentElement

    // Labels for date groups are not worth scraping: the markup is a real
    // <label> in one place, a bare <span id="lbl…"> in another, and elsewhere
    // only a section heading, so proximity searches pick up neighbouring
    // fields. Emit the control name and let the caller supply a display label
    // (see DATE_LABELS). Actions carry dateParts, so nothing routes on this.
    //
    // The word "Date" is forced in because downstream code identifies dates
    // by their caption: a group DATE_LABELS has no entry for would otherwise
    // read "TRAVEL DTE" and be handled as if it were a text box.
    let label = name
      .replace(/_/g, ' ')
      .replace(/\bDTE\b/i, 'Date')
      .replace(/\bDOB\b/i, 'Date of Birth')
      .trim()
    if (!/date/i.test(label)) label += ' Date'

    const validator = container &&
      container.querySelector('[id*="customVal"], [id*="CustomVal"], [id*="csv"]')

    const MONTHS = {
      JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
      JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    }
    let value = ''
    const d = (dayEl.value || '').trim()
    const m = (monthEl.value || '').trim()
    const y = (yearEl.value || '').trim()
    if (d && m && y) {
      const mNum = MONTHS[m.toUpperCase()] || m.replace(/\D/g, '').padStart(2, '0')
      value = `${d.replace(/\D/g, '').padStart(2, '0')}/${mNum}/${y}`
    }

    const ref = base
    const dateCtrls = [dayEl, monthEl, yearEl]
    const triggersPostback = dateCtrls.some(hasPostback)
    const disabled = dateCtrls.every((el) => el.disabled)

    seenRefs.add(ref)
    fields.push({
      ref,
      kind: 'date',
      label,
      value,
      options: null,
      required: Boolean(validator),
      disabled,
      dnaCbxRef: findDnaCbx(dayEl),
      row: parseRow(dayEl.id),
      triggersPostback,
      // The three controls to write, so callers never have to infer them from
      // the label. Passport is the reason: its year box is tbxPPT_ISSUEDYear,
      // not the tbxPPT_ISSUED_DTEYear the other dates' naming would imply.
      dateParts: {
        day: strip(dayEl.id),
        month: strip(monthEl.id),
        year: strip(yearEl.id),
      },
    })
  }

  // ── 3. Regular inputs, selects, textareas ────────────────────────────────
  const allControls = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="image"]):not([type="button"]):not([type="radio"]):not([type="checkbox"]),' +
    'select,' +
    'textarea',
  )

  for (const el of allControls) {
    if (!el.id || !isVisible(el)) continue
    if (!el.id.includes('FormView1')) continue
    if (insideDateDiv(el) || isDatePart(el.id)) continue

    const ref = strip(el.id)
    if (seenRefs.has(ref)) continue

    const tag = el.tagName.toLowerCase()
    let kind = 'text'
    if (tag === 'select')   kind = 'select'
    if (tag === 'textarea') kind = 'textarea'

    const lbl = labelFor(el.id)
    if (!lbl && tag === 'select' && el.id.includes('ddlDOB')) continue // date sub-control
    if (!lbl && (el.id.includes('ddlDOB') || el.id.includes('Day') || el.id.includes('Month') || el.id.includes('Year'))) continue

    let options = null
    if (kind === 'select') {
      const opts = Array.from(el.options).map((o) => ({ value: o.value, text: o.text.trim() }))
      options = opts.length > largeThreshold ? null : opts
      // mark large selects
      if (opts.length > largeThreshold) kind = 'select-large'
    }

    const value = kind === 'select' || kind === 'select-large'
      ? (el.options[el.selectedIndex]?.text?.trim() || '')
      : el.value || ''

    const triggersPostback = hasPostback(el)
    const dnaCbxRef = findDnaCbx(el)
    const hasVal = Boolean(
      el.closest('.field, .field-group, td, tr')?.querySelector('[id*="customVal"], [id*="CustomVal"], [id*="csv"]')
    )

    seenRefs.add(ref)
    fields.push({
      ref,
      kind,
      label: lbl,
      value,
      options,
      required: hasVal,
      disabled: el.disabled,
      dnaCbxRef,
      row: parseRow(el.id),
      triggersPostback,
    })
  }

  // ── 4. Visible checkboxes (excluding DNA gating checkboxes) ───────────────
  const checkboxes = document.querySelectorAll('input[type="checkbox"]')
  for (const cb of checkboxes) {
    if (!cb.id || !isVisible(cb)) continue
    if (!cb.id.includes('FormView1')) continue

    const ref = strip(cb.id)
    if (seenRefs.has(ref)) continue

    // Skip pure DNA (gating) checkboxes — they appear as dnaCbxRef on the gated
    // field. Keep the U.S. contact person-name box: it is a stand-in for both
    // name inputs (the inventory cannot attach it via the nested .field divs).
    const isDna = /cbex.*NA$|cbx.*NA$/i.test(cb.id)
    const isUsPocNameNa = /cbxUS_POC_NAME_NA$/i.test(cb.id)
    if (isDna && !isUsPocNameNa) { seenRefs.add(ref); continue }

    const lbl = labelFor(cb.id)
    seenRefs.add(ref)
    fields.push({
      ref,
      kind: 'checkbox',
      label: lbl,
      value: cb.checked ? 'checked' : '',
      options: null,
      required: false,
      disabled: cb.disabled,
      dnaCbxRef: null,
      row: parseRow(cb.id),
      triggersPostback: hasPostback(cb),
    })
  }

  // Photo tool file inputs are often hidden and live outside FormView1.
  for (const el of document.querySelectorAll('input[type="file"]')) {
    const ref = strip(el.id || '') || 'photoFile'
    if (seenRefs.has(ref)) continue
    seenRefs.add(ref)
    fields.push({
      ref,
      kind: 'file',
      label: labelFor(el.id) || 'Photo',
      value: el.value || '',
      options: null,
      required: true,
      disabled: el.disabled,
      dnaCbxRef: null,
      row: parseRow(el.id),
      triggersPostback: hasPostback(el),
    })
  }

  // ─── buttons ─────────────────────────────────────────────────────────────

  const buttons = []
  const btnSelectors = [
    'input[type="submit"]',
    'input[type="button"]',
    'input[type="image"]',
    'button',
    'a[href*="doPostBack"], a[onclick*="doPostBack"]',
    'a[id*="lnkNew"], a[id*="lnkRetrieve"]',
  ]
  for (const sel of btnSelectors) {
    for (const btn of document.querySelectorAll(sel)) {
      if (!isVisible(btn)) continue
      let text = (
        btn.value ||
        btn.getAttribute('alt') ||
        btn.getAttribute('title') ||
        btn.textContent ||
        ''
      ).replace(/\s+/g, ' ').trim()
      if (!text) {
        const idClass = `${btn.id || ''} ${btn.className || ''}`
        if (/printapp|btnPrintApp/i.test(idClass)) text = 'Print Application'
        else if (/btnSignApp|blankbluebuttonconfirm/i.test(idClass)) text = 'Sign and Submit Application'
        else if (/\bnext\b/i.test(btn.className) || /UpdateButton3/i.test(btn.id)) text = 'Next'
        else if (/btnNoImage/i.test(idClass)) text = 'Continue Without a Photo'
        else if (/choosediffphoto/i.test(idClass)) text = 'Choose a Different Photo'
        else if (/btnUploadPhoto|uploadphoto/i.test(idClass)) text = 'Upload Your Photo'
        else continue
      }
      const ref = strip(btn.id || '')
      buttons.push({ ref, text, triggersPostback: hasPostback(btn) || btn.href?.includes('doPostBack') })
    }
  }

  // ─── errors ──────────────────────────────────────────────────────────────

  const errors = []
  const summaries = document.querySelectorAll(
    '[id$="ValidationSummary"]:not([style*="display:none"]):not([style*="display: none"]),' +
    '.validation-summary-errors,' +
    '.error-message',
  )
  for (const summary of summaries) {
    const items = summary.querySelectorAll('li')
    if (items.length) {
      for (const li of items) {
        const t = li.textContent.replace(/\s+/g, ' ').trim()
        if (t) errors.push(t)
      }
    } else {
      const t = summary.textContent.replace(/\s+/g, ' ').trim()
      if (t) errors.push(t)
    }
  }

  // ─── signature ───────────────────────────────────────────────────────────

  const sigParts = fields
    .filter((f) => f.kind !== 'select-large') // large selects don't change often
    .map((f) => `${f.ref}:${f.value}:${f.disabled}`)
    .join('|')
  const signature = djb2(sigParts)

  return { fields, buttons, errors, signature }
}
