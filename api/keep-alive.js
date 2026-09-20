/**
 * GET /api/keep-alive
 * Daily Vercel Cron pings Supabase so the free project is not paused for inactivity.
 * Vercel sends Authorization: Bearer <CRON_SECRET>.
 */
import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const cronSecret = process.env.CRON_SECRET?.trim()
  if (cronSecret) {
    const auth = String(req.headers.authorization || '')
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return res.status(503).json({ error: 'Supabase not configured' })
  }

  try {
    const db = createClient(url, key, { auth: { persistSession: false } })
    const { error } = await db.from('users').select('user_id').limit(1)
    if (error) {
      console.error('[keep-alive]', error.message)
      return res.status(500).json({ error: 'Supabase ping failed' })
    }
    return res.status(200).json({ ok: true })
  } catch (e) {
    console.error('[keep-alive]', e)
    return res.status(500).json({ error: e?.message || 'Keep-alive failed' })
  }
}
