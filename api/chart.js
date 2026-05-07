// ─────────────────────────────────────────────────────────────────────────────
// /api/chart — Natal chart endpoint
// ─────────────────────────────────────────────────────────────────────────────
// Thin HTTP wrapper around lib/chart.js. The frontend (index.html) calls this
// endpoint in parallel with the chat request when a user submits the form;
// the chart streams back as JSON and gets cached as a hidden user message in
// the chat history so subsequent turns don't re-fetch.
//
// History: this endpoint previously contained the full ~830-line chart
// engine (JPL fetching, Lahiri ayanamsa, dignity, houses, convergences,
// geocoding). That logic has moved to lib/chart.js as the single source of
// truth, shared with the cache-fallback path in /api/chat. This file is now
// just request validation, the buildChart call, and response shaping.
//
// Vercel maxDuration:30 stays — JPL fetches still gate the response and the
// batched+rescue strategy in lib/chart.js can take up to ~27s in the worst
// case (3 batches × 9s per-planet timeout). Bumping below this risks killing
// healthy-but-slow JPL responses.

import { buildChart } from '../lib/chart.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { birthday, birthplace, birthtime } = req.body || {};
    if (!birthday) return res.status(400).json({ error: 'birthday required' });

    // buildChart handles date normalization, geocoding, JPL fetching,
    // ascendant computation, house structure, and convergence detection.
    // Throws on invalid birthday format.
    const result = await buildChart({ birthday, birthplace, birthtime });

    // Response shape preserved from the previous endpoint — additive only.
    // index.html reads: chart, rahuKetu, ascendant, houses, convergences,
    // coords, jplDate, planetsFound, failedPlanets. The new fields
    // (geocodeImprecise, geocodeMethod, sunSignMismatch, dayOfWeekRuler) pass
    // through; the frontend ignores fields it doesn't consume, and the
    // ones that read these (cache-text builder for the system prompt) get
    // them when they look.
    return res.status(200).json({
      chart: result.chart,
      rahuKetu: result.rahuKetu,
      ascendant: result.ascendant,
      houses: result.houses,
      convergences: result.convergences,
      coords: result.coords,
      jplDate: result.jplDate,
      planetsFound: Object.keys(result.chart || {}).length,
      failedPlanets: result.failedPlanets,
      // New fields surfaced by the consolidated engine. Safe to add — the
      // frontend pulls fields by name and ignores anything it doesn't read.
      sunSignMismatch: result.sunSignMismatch,
      dayOfWeekRuler: result.dayOfWeekRuler,
      geocodeImprecise: result.geocodeImprecise,
      geocodeMethod: result.geocodeMethod,
    });
  } catch (err) {
    console.error('Chart API error:', err.message, err.stack);
    // Distinguish bad input (caller's fault) from internal failures
    if (err.message === 'birthday required' || err.message === 'invalid birthday') {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: err.message });
  }
}
