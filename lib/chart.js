// ─────────────────────────────────────────────────────────────────────────────
// lib/chart.js — Mor Doo chart engine (consolidated)
// ─────────────────────────────────────────────────────────────────────────────
// One source of truth for natal chart computation. Both /api/chart (the
// frontend-triggered chart endpoint) and /api/chat (the reading endpoint with
// its cache-fallback path) import from here. Before this consolidation the
// same logic lived in two places that were required to "stay in sync" by
// comment alone — silent drift was a real risk and would have surfaced as
// users seeing different placements depending on which path served them.
//
// Scope: pure dedup. No new schema fields, no v0.7 logic. Behavior is
// identical to the union of the two prior engines, with the strictly-better
// version chosen where they differed:
//   - Batched JPL fetch + rescue pass (from chart.js) over parallel-all
//   - Country-coordinate fallback (from chat.js) over city-only
//   - Rich SIGN_PLANET_MEANING strings (from chat.js) over terser SIGN_MEANINGS
//   - Sun-sign mismatch detection (from chat.js)
//   - House structure + convergences (from chart.js)
//
// Thai sidereal: JPL Horizons returns tropical (geocentric ecliptic)
// longitudes. Thai horasaat uses sidereal — Lahiri ayanamsa correction is
// applied in lonToSign() before any sign assignment. All sign output
// downstream is Thai sidereal.
//
// Schema position: this module currently produces the v0.6 chart object.
// v0.7 expansion (9-flag dignity, nakshatra, Tanu Sesa, dasha periods,
// Suriyayatra) will land as additional fields on the same object — slot
// names left vacant in this file for that purpose are commented as such.
//
// ── Blended engine philosophy ────────────────────────────────────────────
// Mor Doo is not a Suriyayatra purist app and not a JPL+Lahiri modernist
// app. It is an extended-traditional system: Suriyayatra is the source of
// truth for the seven traditional grahas (Sun, Moon, Mars, Mercury, Jupiter,
// Venus, Saturn) — the bodies the ancient teachings actually compute.
// JPL+Lahiri extends the system honestly to bodies the ancients didn't know
// (Uranus, Neptune, Pluto, asteroids if ever added) and to derived points
// like Rahu/Ketu where Suriyayatra has its own formulation we may swap in
// later. The reading layer can speak to the texture when relevant; for most
// readings the source is invisible.
//
// Every planet position carries a `source` field tagging which engine
// produced it:
//   "jpl"          — JPL Horizons longitude with Lahiri ayanamsa applied
//   "suriyayatra"  — full Thai canonical computation (mandocca + śīghra
//                    corrections from tabular constants, no ephemeris)
//   "computed"     — derived mathematically from formula + epoch (Rahu/Ketu
//                    mean nodes; eventual Suriyayatra-side node calc lands
//                    here as "suriyayatra" when ready)
//
// Today every position is tagged "jpl" or "computed" because the Suriyayatra
// engine isn't built yet. When mandocca research lands, the seven traditional
// grahas flip to "suriyayatra" — chart object SHAPE doesn't change, only the
// data on the source field changes. This is the staging contract: ship now
// honestly tagged, evolve the data in place without breaking consumers.

// ─────────────────────────────────────────────────────────────────────────────
// Constants — JPL planet IDs, zodiac, dignity, sign-meaning tables
// ─────────────────────────────────────────────────────────────────────────────

const JPL_PLANETS = {
  Sun:     '10',
  Moon:    '301',
  Mercury: '199',
  Venus:   '299',
  Mars:    '499',
  Jupiter: '599',
  Saturn:  '699',
  // Uranus/Neptune intentionally omitted from default fetch — not used in
  // Thai/Vedic readings. JPL IDs '799'/'899' if ever needed.
};

const ZODIAC_SIGNS = [
  'Aries','Taurus','Gemini','Cancer','Leo','Virgo',
  'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'
];

// Sign rulership — which planet "owns" each sign. Standard Thai/Vedic table.
// Used to compute house lords (the planet that rules each house's sign).
const SIGN_LORD = {
  Aries: 'Mars',       Taurus: 'Venus',     Gemini: 'Mercury',
  Cancer: 'Moon',      Leo: 'Sun',          Virgo: 'Mercury',
  Libra: 'Venus',      Scorpio: 'Mars',     Sagittarius: 'Jupiter',
  Capricorn: 'Saturn', Aquarius: 'Saturn',  Pisces: 'Jupiter',
};

// 4-state dignity. v0.7 will replace this with the 9-flag taxonomy
// (uccha / mūla / sva / mitra / sama / śatru / nīcha / combust / retrograde).
// Combust + retrograde require switching the JPL QUANTITIES parameter to
// fetch daily motion and apparent magnitude; mitra/sama/śatru need a
// friendship table. Slot left here as `dignity` (string) for now.
const PLANET_DIGNITY = {
  Sun:     { own: ['Leo'],                    exalted: ['Aries'],       debilitated: ['Libra'] },
  Moon:    { own: ['Cancer'],                 exalted: ['Taurus'],      debilitated: ['Scorpio'] },
  Mercury: { own: ['Gemini','Virgo'],         exalted: ['Virgo'],       debilitated: ['Pisces'] },
  Venus:   { own: ['Taurus','Libra'],         exalted: ['Pisces'],      debilitated: ['Virgo'] },
  Mars:    { own: ['Aries','Scorpio'],        exalted: ['Capricorn'],   debilitated: ['Cancer'] },
  Jupiter: { own: ['Sagittarius','Pisces'],   exalted: ['Cancer'],      debilitated: ['Capricorn'] },
  Saturn:  { own: ['Capricorn','Aquarius'],   exalted: ['Libra'],       debilitated: ['Aries'] },
};

// Per-placement interpretation strings woven into reading prose. Lived
// language only — no Thai/Sanskrit terminology in user-facing output.
const SIGN_PLANET_MEANING = {
  Sun: {
    Aries:'Sun is exalted here — unusually strong leadership and vitality, a pioneer spirit that rarely backs down',
    Taurus:'Sun in Taurus — determined, wealth-oriented, slow to act but powerful once committed',
    Gemini:'Sun in Gemini — communicative, quick, dual nature, strength comes from adaptability',
    Cancer:'Sun in Cancer — protective, intuitive, family-driven, strength is emotional intelligence',
    Leo:'Sun in Leo — at home, full brightness, natural authority, warmth that draws others naturally',
    Virgo:'Sun in Virgo — analytical, precise, service-oriented, strength is in details others miss',
    Libra:'Sun is debilitated here — authority is softened, balance matters more than winning, partnership is the vehicle',
    Scorpio:'Sun in Scorpio — intense, private, transformative power, strength is hidden until needed',
    Sagittarius:'Sun in Sagittarius — expansive, philosophical, freedom-seeking, strength is in vision',
    Capricorn:'Sun in Capricorn — disciplined, ambitious, karmic responsibility, strength builds slowly but lastingly',
    Aquarius:'Sun in Aquarius — independent, unconventional, community-minded, strength is collective',
    Pisces:'Sun in Pisces — intuitive, compassionate, spiritual, strength is subtle and deeply feeling',
  },
  Moon: {
    Aries:'Moon in Aries — emotional reactions are quick and direct, instincts favor action over reflection',
    Taurus:'Moon is exalted here — emotional nature is stable, grounded, deeply sensory, finds peace in the physical world',
    Gemini:'Moon in Gemini — emotionally curious and changeable, needs mental stimulation to feel secure',
    Cancer:'Moon is at home — deeply nurturing, intuitive, emotions run deep and protective instincts are strong',
    Leo:'Moon in Leo — warm and generous emotionally, needs recognition, gives loyalty and expects it in return',
    Virgo:'Moon in Virgo — emotional security comes through order, service, and usefulness',
    Libra:'Moon in Libra — needs harmony and balance emotionally, partnership is essential for inner peace',
    Scorpio:'Moon is debilitated here — emotional intensity is difficult to contain, transformation through feeling is the path',
    Sagittarius:'Moon in Sagittarius — emotional freedom is essential, philosophy and travel feed the inner life',
    Capricorn:'Moon in Capricorn — emotional restraint, security comes through achievement and structure',
    Aquarius:'Moon in Aquarius — emotionally detached but humanitarian, needs intellectual connection to feel close',
    Pisces:'Moon in Pisces — deeply empathic, boundaries dissolve easily, intuition is the primary emotional language',
  },
  Mercury: {
    Aries:'Mercury in Aries — quick direct thinking, says what it means immediately',
    Taurus:'Mercury in Taurus — slow deliberate communication, thinks before speaking, reliable word',
    Gemini:'Mercury is at home — fast versatile mind, comfortable with many ideas at once',
    Cancer:'Mercury in Cancer — emotional intelligence, thinks through feeling, excellent memory',
    Leo:'Mercury in Leo — speaks with authority and drama, communication is performance',
    Virgo:'Mercury is exalted and at home — analytical precision at its peak, detail-oriented mind',
    Libra:'Mercury in Libra — balanced fair communication, natural diplomat',
    Scorpio:'Mercury in Scorpio — investigative deep thinking, reads between every line',
    Sagittarius:'Mercury in Sagittarius — big picture thinking, philosophical communication',
    Capricorn:'Mercury in Capricorn — structured practical thinking, says what it means to accomplish',
    Aquarius:'Mercury in Aquarius — innovative unconventional thinking, ahead of the conversation',
    Pisces:'Mercury is debilitated — thinking is intuitive not logical, communication flows better through art than argument',
  },
  Venus: {
    Aries:'Venus in Aries — love is direct and fast-moving, wealth comes through bold action',
    Taurus:'Venus is at home — deep capacity for beauty, loyalty, and material abundance',
    Gemini:'Venus in Gemini — charm through words and wit, love needs variety and mental connection',
    Cancer:'Venus in Cancer — love is nurturing and protective, home and family are the heart of wealth',
    Leo:'Venus in Leo — generous and dramatic in love, wealth and beauty are displayed openly',
    Virgo:'Venus is debilitated here — love is expressed through service and detail, often understated',
    Libra:'Venus is at home — refined, partnership-oriented, natural eye for beauty and fairness',
    Scorpio:'Venus in Scorpio — intense and loyal in love, wealth comes through depth and transformation',
    Sagittarius:'Venus in Sagittarius — freedom in love, wealth through adventure and expansion',
    Capricorn:'Venus in Capricorn — love is expressed through commitment and reliability, wealth is built carefully',
    Aquarius:'Venus in Aquarius — unconventional in love, wealth through innovation and community',
    Pisces:'Venus is exalted here — the most compassionate and spiritually rich placement for love and beauty',
  },
  Mars: {
    Aries:'Mars is at home — direct, competitive, high energy, acts first and considers later',
    Taurus:'Mars in Taurus — slow to anger but formidable once committed, persistence is the weapon',
    Gemini:'Mars in Gemini — quick, verbal, fights with words and wit, energy scattered across many fronts',
    Cancer:'Mars is debilitated here — action is filtered through emotion, indirect but deeply protective',
    Leo:'Mars in Leo — bold, proud, leads with heart, energy goes to creative and leadership pursuits',
    Virgo:'Mars in Virgo — precise and methodical, energy goes into craft and perfection',
    Libra:'Mars in Libra — acts through negotiation, conflict-averse, energy toward partnership',
    Scorpio:'Mars is at home — strategic, intense, hidden strength that strikes when ready',
    Sagittarius:'Mars in Sagittarius — philosophical warrior, fights for beliefs, energy is expansive',
    Capricorn:'Mars is exalted — disciplined ambition, systematic drive toward long-term goals',
    Aquarius:'Mars in Aquarius — unconventional energy, fights for collective causes',
    Pisces:'Mars in Pisces — intuitive action, energy flows best when guided by feeling',
  },
  Jupiter: {
    Aries:'Jupiter in Aries — expansion through initiative, luck favors those who act first',
    Taurus:'Jupiter in Taurus — wealth through patience and material mastery',
    Gemini:'Jupiter in Gemini — expansion through communication and knowledge',
    Cancer:'Jupiter is exalted — deep abundance, nurturing wisdom, luck flows through family and home',
    Leo:'Jupiter in Leo — generous and visible expansion, abundance through leadership',
    Virgo:'Jupiter in Virgo — expansion through service and precision, careful stewardship',
    Libra:'Jupiter in Libra — abundance through partnership and fairness',
    Scorpio:'Jupiter in Scorpio — expansion through depth, transformation, hidden resources',
    Sagittarius:'Jupiter is at home — full philosophical wisdom, natural abundance, teaching and vision at their best',
    Capricorn:'Jupiter is debilitated — expansion is slow and requires structure, abundance through discipline only',
    Aquarius:'Jupiter in Aquarius — collective wisdom, expansion through innovation and community',
    Pisces:'Jupiter is at home — compassionate wisdom, spiritual abundance, healing gifts',
  },
  Saturn: {
    Aries:'Saturn is debilitated — discipline resists impulsiveness, karmic work is learning patience',
    Taurus:'Saturn in Taurus — slow and deliberate material building, wealth through persistence',
    Gemini:'Saturn in Gemini — structured communication, karmic lessons through words and information',
    Cancer:'Saturn in Cancer — emotional discipline, karmic work is learning to receive as well as give',
    Leo:'Saturn in Leo — lessons in ego and recognition, leadership earned not assumed',
    Virgo:'Saturn in Virgo — disciplined service, karmic returns through precision and health',
    Libra:'Saturn is exalted — fairness and justice are fully expressed, karmic balance is achievable',
    Scorpio:'Saturn in Scorpio — deep karmic transformation, discipline through loss and regeneration',
    Sagittarius:'Saturn in Sagittarius — structured philosophy, wisdom earned through long journeys',
    Capricorn:'Saturn is at home — full expression of discipline, authority built over decades',
    Aquarius:'Saturn is at home — structured innovation, karmic duty to the collective',
    Pisces:'Saturn in Pisces — karmic lessons in boundaries and reality, discipline through compassion',
  },
};

// House meanings in plain English for prose synthesis. No Thai/Sanskrit
// terminology in user-facing strings. Mapping from Thai bhava names:
//   1 ตนุ → self/body  ·  2 กดุมภะ → money/voice  ·  3 สหัชชะ → siblings/courage
//   4 พันธุ → home/family  ·  5 ปุตตะ → children/creativity
//   6 อริ → struggles/health  ·  7 ปัตนิ → partnership
//   8 มรณะ → hidden/inheritance  ·  9 สุภะ → fortune/teachers
//   10 กัมมะ → career/reputation  ·  11 ลาภะ → gains/friendships
//   12 วินาศ → endings/private
const HOUSE_MEANING = {
  1:  'self, body, how you show up in the world',
  2:  'money, what you accumulate, your voice',
  3:  'younger siblings, short journeys, courage',
  4:  'home, family, mother, property, foundation',
  5:  'children, creativity, what you originate',
  6:  'struggles, health, daily work, debt',
  7:  'partner, marriage, open opposition',
  8:  'inheritance, hidden things, transformation',
  9:  'fortune, faith, father, long journeys, teachers',
  10: 'career, reputation, authority, what you produce',
  11: 'gains, friendships, older siblings, hopes',
  12: 'endings, hidden things, private life, retreat',
};

// Antonati Saman rise-time table — minutes per sign, totals 1440 (24h).
// 1 antonati = 24 minutes. Reference: zodietcwise.blogspot.com (Thai source).
//   Aries 5  Taurus 4  Gemini 3   Cancer 5  Leo 6     Virgo 7
//   Libra 7  Scorpio 6 Sagit 5    Capr 3    Aquar 4   Pisces 5
// Verified against myhora.com Welmanee 1992-02-26 — reproduces Libra 28°53'.
const ANTONATI_MINUTES = [120, 96, 72, 120, 144, 168, 168, 144, 120, 72, 96, 120];

// ─────────────────────────────────────────────────────────────────────────────
// Lahiri ayanamsa & sign assignment
// ─────────────────────────────────────────────────────────────────────────────

// Lahiri ayanamsa — angular offset between tropical and Thai sidereal zodiacs.
// Quadratic fit to high-precision Swiss Ephemeris values 1900–2026, max
// residual 0.0015°. Reference values:
//   1992-02-26: 23.6938°    2000-01-01: 23.8531°    2026-01-01: 24.2188°
// A 0.05° error cannot push a planet across a 30° sign boundary unless the
// planet was already within 0.05° of the cusp — borderline regardless.
function getLahiriAyanamsa(dateStr) {
  if (!dateStr) return 23.85;
  try {
    const date = new Date(dateStr + 'T12:00:00Z');
    if (isNaN(date.getTime())) return 23.85;
    const j2000 = new Date('2000-01-01T12:00:00Z');
    const days = (date - j2000) / (24 * 60 * 60 * 1000);
    const t = days / 36525;  // Julian centuries from J2000
    return 23.854565 + 1.394796 * t + 0.001079 * t * t;
  } catch (e) {
    return 23.85;
  }
}

// Convert tropical ecliptic longitude to Thai sidereal sign + degree.
// Returned `longitude` is sidereal (post-ayanamsa).
function lonToSign(lon, dateStr) {
  const ayan = getLahiriAyanamsa(dateStr);
  const sidereal = ((lon - ayan) % 360 + 360) % 360;
  return {
    sign: ZODIAC_SIGNS[Math.floor(sidereal / 30)],
    degree: Math.floor(sidereal % 30),
    longitude: sidereal,
  };
}

function getDignity(planet, sign) {
  const d = PLANET_DIGNITY[planet];
  if (!d) return '';
  if (d.own && d.own.includes(sign)) return 'own sign';
  if (d.exalted && d.exalted.includes(sign)) return 'exalted';
  if (d.debilitated && d.debilitated.includes(sign)) return 'debilitated';
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Western tropical sun sign + Thai/Western reconciliation
// ─────────────────────────────────────────────────────────────────────────────

// Date-table lookup — what Western horoscope columns would call this person's
// sun sign. Used only to detect mismatch with the Thai sidereal placement so
// we can surface a single reconciliation sentence.
function getWesternTropicalSunSign(birthdayStr) {
  if (!birthdayStr) return null;
  const parts = birthdayStr.split('-');
  if (parts.length < 3) return null;
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  if (isNaN(m) || isNaN(d)) return null;
  const boundaries = [
    [1, 20,  'Capricorn'],   [1, 32,  'Aquarius'],
    [2, 19,  'Aquarius'],    [2, 30,  'Pisces'],
    [3, 21,  'Pisces'],      [3, 32,  'Aries'],
    [4, 20,  'Aries'],       [4, 31,  'Taurus'],
    [5, 21,  'Taurus'],      [5, 32,  'Gemini'],
    [6, 21,  'Gemini'],      [6, 31,  'Cancer'],
    [7, 23,  'Cancer'],      [7, 32,  'Leo'],
    [8, 23,  'Leo'],         [8, 32,  'Virgo'],
    [9, 23,  'Virgo'],       [9, 31,  'Libra'],
    [10,23,  'Libra'],       [10,32,  'Scorpio'],
    [11,22,  'Scorpio'],     [11,31,  'Sagittarius'],
    [12,22,  'Sagittarius'], [12,32,  'Capricorn'],
  ];
  for (const [bm, bd, sign] of boundaries) {
    if (m < bm) continue;
    if (m === bm && d < bd) return sign;
  }
  return 'Capricorn';
}

function detectSunSignMismatch(birthdayStr, thaiSunSign) {
  if (!birthdayStr || !thaiSunSign) return { differs: false };
  const westernSign = getWesternTropicalSunSign(birthdayStr);
  if (!westernSign || westernSign === thaiSunSign) return { differs: false };
  const parts = birthdayStr.split('-');
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  const cuspDays = {
    1: [19,20], 2: [18,19], 3: [20,21], 4: [19,20], 5: [20,21],
    6: [20,21], 7: [22,23], 8: [22,23], 9: [22,23], 10:[22,23],
    11:[21,22], 12:[21,22]
  };
  const isCusp = cuspDays[m] && (cuspDays[m].includes(d) || cuspDays[m].includes(d-1) || cuspDays[m].includes(d+1));
  const sentence = `In the Thai sky you are ${thaiSunSign}. The West would call you ${westernSign} — same sun, read against a different horizon.`;
  return { differs: true, thaiSign: thaiSunSign, westernSign, isCusp, sentence };
}

// ─────────────────────────────────────────────────────────────────────────────
// JPL Horizons fetch — batched + rescue pass
// ─────────────────────────────────────────────────────────────────────────────
//
// Architecture: two batches run serially with a shared per-planet timeout.
// Within each batch fetches run in parallel; the slowest gates the batch.
// A rescue pass retries any planets that failed on the first attempt.
//
// Per-planet timeout sized to fit Vercel's 30s function limit:
//   batch1 (Sun/Moon/Mercury/Venus) + batch2 (Mars/Jupiter/Saturn) + rescue
//   = 9s × 3 = 27s worst case, leaving ~3s for parsing and serialization.
//
// History note: timeout was originally 7s under Hobby tier's 10s limit. On
// Vercel Pro with maxDuration:30 the 7s was the actual bottleneck — JPL
// fetches that legitimately took 7-9s under load (Sun, Moon, Jupiter when
// JPL is busy) were being killed early, producing partial charts. 9s + a
// rescue batch removes the false-alarm timeouts.

// Parser returns either { ok: true, longitude: number } or
// { ok: false, reason: string, diagnostic: object }. The diagnostic captures
// just enough of the response to identify which JPL failure mode was hit
// without flooding logs with full ~10-50KB responses. fetchPlanetPosition
// passes this back up so getBirthChart can log per-planet failure causes.
function parseJPLLongitude(resultText) {
  const responseLen = resultText ? resultText.length : 0;

  if (!resultText) {
    return { ok: false, reason: 'empty_response', diagnostic: { responseLen: 0 } };
  }

  // Many JPL errors come back as plaintext like "No matches found" or
  // "Cannot find target body" — these don't contain $$SOE/$$EOE markers
  // and the empty-response path above won't catch them. Detect a few common
  // error strings up front so logs say WHY rather than just "no markers."
  const errorMatch = resultText.match(/^[\s\S]{0,2000}?(No matches found|Cannot find|API SERVICE ERROR|Connection refused|exceeded.*request)/i);

  try {
    const soeIdx = resultText.indexOf('$$SOE');
    const eoeIdx = resultText.indexOf('$$EOE');

    if (soeIdx === -1 || eoeIdx === -1) {
      return {
        ok: false,
        reason: errorMatch ? 'jpl_error_message' : 'no_data_markers',
        diagnostic: {
          responseLen,
          jplErrorMessage: errorMatch ? errorMatch[1] : null,
          // First 500 bytes is enough to see error/header content
          responseHead: resultText.slice(0, 500),
        }
      };
    }

    const beforeSOE = resultText.slice(0, soeIdx);
    const headerLines = beforeSOE.trim().split('\n');
    const headerLine = headerLines[headerLines.length - 1];
    const headers = headerLine.split(',').map(s => s.trim().toLowerCase());

    let lonColIdx = headers.findIndex(h =>
      h.includes('obseclon') || h.includes('eclon') || h.includes('obs_eclon')
    );

    const dataSection = resultText.slice(soeIdx + 5, eoeIdx).trim();
    const lines = dataSection.split('\n').filter(l => l.trim() && !l.startsWith('$$'));

    if (!lines.length) {
      return {
        ok: false,
        reason: 'empty_data_section',
        diagnostic: {
          responseLen,
          headerLine,
          dataSection: dataSection.slice(0, 300),
        }
      };
    }

    const cols = lines[0].split(',').map(s => s.trim());

    if (lonColIdx !== -1) {
      const lon = parseFloat(cols[lonColIdx]);
      if (!isNaN(lon)) return { ok: true, longitude: lon };
    }

    // Fallback: scan all columns for first valid longitude (0-360).
    // JPL format has empty placeholder cols: "Date, , , ObsEcLon, ObsEcLat".
    for (let i = 1; i < cols.length; i++) {
      const val = parseFloat(cols[i]);
      if (!isNaN(val) && val >= 0 && val <= 360) return { ok: true, longitude: val };
    }

    // Got data, found columns, but no parseable longitude in any column.
    // This is the trickiest failure to diagnose — capture columns + headers
    // so we can see if JPL changed format or if we got a row of NaN/NaN/NaN.
    return {
      ok: false,
      reason: 'no_valid_longitude_in_columns',
      diagnostic: {
        responseLen,
        headerLine,
        firstDataRow: lines[0],
        cols,
        lonColIdx,
        numLines: lines.length,
      }
    };
  } catch (e) {
    return {
      ok: false,
      reason: 'parser_exception',
      diagnostic: {
        responseLen,
        exception: e.message,
        responseHead: resultText.slice(0, 300),
      }
    };
  }
}

async function fetchPlanetPosition(jplId, dateStr) {
  const [y, m, d] = dateStr.split('-');
  const stop = new Date(parseInt(y), parseInt(m)-1, parseInt(d)+1);
  const stopStr = stop.getFullYear() + '-' +
    String(stop.getMonth()+1).padStart(2,'0') + '-' +
    String(stop.getDate()).padStart(2,'0');

  // Build URL manually — URLSearchParams encodes ' to %27 which JPL rejects.
  // QUANTITIES='31' is observer ecliptic lon/lat only. v0.7 will need '19,20,31'
  // (or similar) to capture daily motion (retrograde detection) and apparent
  // magnitude (combustion detection) for the 9-flag dignity taxonomy.
  const url = 'https://ssd.jpl.nasa.gov/api/horizons.api' +
    '?format=text' +
    `&COMMAND='${jplId}'` +
    `&EPHEM_TYPE='OBSERVER'` +
    `&CENTER='500@399'` +
    `&START_TIME='${dateStr}'` +
    `&STOP_TIME='${stopStr}'` +
    `&STEP_SIZE='1d'` +
    `&QUANTITIES='31'` +
    `&CSV_FORMAT='YES'`;

  // Single fetch+parse attempt. Returns { ok: true, longitude } on success or
  // { ok: false, reason, diagnostic, retryable } on failure. The `retryable`
  // flag tells the outer retry loop whether another attempt has any chance
  // of helping — only network-level transients are worth retrying. Parse
  // failures (JPL returned data we couldn't read) won't fix themselves on
  // a second identical request.
  async function fetchOnce() {
    const startTime = Date.now();
    let httpStatus = null;
    let text = null;

    try {
      const fetchP = fetch(url).then(async (r) => {
        httpStatus = r.status;
        return r.text();
      });
      const timeoutP = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('JPL timeout')), 9000)
      );
      text = await Promise.race([fetchP, timeoutP]);
    } catch (e) {
      const elapsed = Date.now() - startTime;
      const isTimeout = e.message === 'JPL timeout';
      // Timeouts and connection errors are retryable — JPL might respond
      // faster on the second attempt, especially if the first one hit a
      // sick backend. fetch() never throws on 4xx/5xx (those are caught
      // below by the parser), so anything throwing here is pre-response.
      return {
        ok: false,
        reason: isTimeout ? 'fetch_timeout' : 'fetch_error',
        diagnostic: { elapsedMs: elapsed, httpStatus, errorMessage: e.message },
        retryable: true,
      };
    }

    const elapsed = Date.now() - startTime;
    const parseResult = parseJPLLongitude(text);

    if (parseResult.ok) return parseResult;

    // Fold fetch metadata into parser diagnostic so failure logs are complete
    parseResult.diagnostic = {
      ...parseResult.diagnostic,
      elapsedMs: elapsed,
      httpStatus,
    };

    // Retry policy: only HTTP 5xx (server-side transients) are worth retrying.
    // Today's production diagnostic showed JPL serving 503 with an HTML status
    // page — load-balancer routing failures that resolve in <300ms. A second
    // attempt has a high chance of hitting a healthy backend.
    //
    // Why we DON'T retry other failure modes:
    // - Parse failures (no_data_markers with httpStatus=200, no_valid_longitude_in_columns):
    //   JPL served real data we couldn't read. Same data on retry → same parse failure.
    // - 4xx errors (bad request, not found): our request was wrong. Retrying
    //   the same wrong request gets the same wrong response.
    // - jpl_error_message: JPL explicitly told us the request can't be served
    //   (e.g. "No matches found"). Retrying doesn't change what JPL knows.
    parseResult.retryable = (httpStatus !== null && httpStatus >= 500 && httpStatus < 600);
    return parseResult;
  }

  // First attempt
  let result = await fetchOnce();
  if (result.ok) return result;
  if (!result.retryable) {
    // Strip the internal `retryable` flag before returning — caller doesn't need it
    delete result.retryable;
    return result;
  }

  // Retryable failure — wait briefly, try once more. 200ms is enough for JPL's
  // load balancer to route to a different backend; short enough that a healthy
  // chart still completes well within the per-planet 9s budget × 2 attempts
  // = ~18s worst case, comfortable inside the rescue pass's overall timing.
  console.log(
    `[chart] inner retry: jplId=${jplId} date=${dateStr} reason=${result.reason} httpStatus=${result.diagnostic.httpStatus} — backing off 200ms`
  );
  await new Promise((r) => setTimeout(r, 200));

  const retryResult = await fetchOnce();
  if (retryResult.ok) {
    console.log(`[chart] inner retry RECOVERED: jplId=${jplId} date=${dateStr}`);
    return retryResult;
  }

  // Retry also failed. Annotate the diagnostic so the outer rescue pass and
  // its log can see this was already retried once at the inner layer (i.e.
  // by the time we're in the outer rescue, JPL has already had two chances
  // for this planet and missed both).
  delete retryResult.retryable;
  retryResult.diagnostic = {
    ...retryResult.diagnostic,
    innerRetryAttempted: true,
    firstAttemptReason: result.reason,
    firstAttemptStatus: result.diagnostic.httpStatus,
  };
  return retryResult;
}

// Fetch all 7 traditional planets for a given date.
//
// Returns: { Sun: {sign, degree, dignity, meaning}, ..., __failedPlanets, __sunSignMismatch }
//   - Per-planet object: sign (Thai sidereal), degree (0-29 int), dignity (string), meaning (string)
//   - __failedPlanets: non-enumerable array of planet names that didn't return
//   - __sunSignMismatch: non-enumerable mismatch metadata (only when Sun fetched and differs)
//
// The non-enumerable metadata pattern is intentional — existing
// Object.entries / Object.keys iteration in formatters skips it without
// special-case code, while consumers that know to look for it (the
// reconciliation surfacing path, the partial-fetch UI notice) can find it.
async function getBirthChart(dateStr) {
  const planets = ['Sun','Moon','Mercury','Venus','Mars','Jupiter','Saturn'];
  const results = {};
  let failed = [];

  // Batch 1: Sun, Moon, Mercury, Venus (most important for Thai reading)
  // Batch 2: Mars, Jupiter, Saturn
  const batch1 = planets.slice(0, 4);
  const batch2 = planets.slice(4);

  const runBatch = async (batch, attemptLabel) => {
    await Promise.allSettled(batch.map(async (p) => {
      // Skip planets we've already successfully fetched (relevant on retry).
      if (results[p]) return;

      // fetchPlanetPosition now returns structured { ok, longitude } on
      // success or { ok, reason, diagnostic } on failure. The diagnostic
      // is logged in full so we can see WHY the failure happened —
      // timeout vs HTTP error vs parser confusion vs JPL error message.
      const result = await fetchPlanetPosition(JPL_PLANETS[p], dateStr);

      if (result.ok && typeof result.longitude === 'number') {
        const { sign, degree } = lonToSign(result.longitude, dateStr);
        const dignity = getDignity(p, sign);
        const meaning = (SIGN_PLANET_MEANING[p] && SIGN_PLANET_MEANING[p][sign]) || '';
        // source:"jpl" — JPL Horizons longitude with Lahiri applied. When
        // the Suriyayatra engine lands, this flips to "suriyayatra" for the
        // seven traditional grahas without changing the object shape.
        results[p] = { sign, degree, dignity, meaning, source: 'jpl' };
        return;
      }

      // Failure path. Stash for rescue/final-failure tracking AND log
      // the full diagnostic so production logs show why each planet failed.
      // The diagnostic object is intentionally JSON-stringified — Vercel
      // log viewers handle multi-line JSON well, and this preserves all
      // fields (httpStatus, elapsedMs, responseHead, jplErrorMessage, etc.)
      // for whoever reads the logs to diagnose what JPL actually did.
      failed.push({ planet: p, reason: result.reason, diagnostic: result.diagnostic });
      console.error(
        `[chart] ${attemptLabel} ${p} FAIL reason=${result.reason} date=${dateStr} diag=${JSON.stringify(result.diagnostic)}`
      );
    }));
  };

  await runBatch(batch1, 'batch1');
  await runBatch(batch2, 'batch2');

  // Rescue pass — JPL Horizons is intermittently flaky. Even when its servers
  // are healthy, a single retry recovers most transient failures. Successfully
  // rescued planets land in `results` (the `if (results[p]) return` guard
  // makes the retry a no-op for them) and drop off the post-rescue `failed`
  // list. Reset `failed` before retry so re-failures get re-counted.
  if (failed.length > 0) {
    console.log(`[chart] rescue pass: retrying ${failed.length} planets:`,
      failed.map(f => f.planet).join(', '));
    const toRetry = failed.map(f => f.planet);
    failed = [];
    await runBatch(toRetry, 'rescue');
  }

  console.log(`[chart] fetched: ${Object.keys(results).join(', ')} (${Object.keys(results).length}/7) date=${dateStr}`);
  if (failed.length > 0) {
    // Final-failure summary — these planets failed twice. The per-planet
    // diagnostic was already logged during runBatch; this is the rolled-up
    // view for filtering ("show me all charts where Moon failed twice").
    console.error(`[chart] PARTIAL CHART date=${dateStr} failed=${failed.length}/7 planets=[${failed.map(f => f.planet + ':' + f.reason).join(', ')}]`);
  }

  // Stash failed-planets list as non-enumerable so iteration patterns skip it.
  Object.defineProperty(results, '__failedPlanets', {
    value: failed.map(f => f.planet),
    enumerable: false, writable: true, configurable: true,
  });

  // Attach sun-sign mismatch metadata (also non-enumerable) when Sun fetched.
  if (results.Sun) {
    const mismatch = detectSunSignMismatch(dateStr, results.Sun.sign);
    if (mismatch.differs) {
      Object.defineProperty(results, '__sunSignMismatch', {
        value: mismatch,
        enumerable: false, writable: true, configurable: true,
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rahu / Ketu (Moon's mean nodes — mathematical, no JPL fetch)
// ─────────────────────────────────────────────────────────────────────────────
//
// Rahu = mean ascending node of Moon's orbit. Reference: Rahu was at ~125.04°
// (tropical) on Jan 1, 2000 (J2000 epoch), retrograde ~19.3568°/year.
// Sign placement is Thai sidereal via lonToSign().
function getRahuKetu(dateStr) {
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return {};
    const j2000 = new Date('2000-01-01');
    const yearsElapsed = (date - j2000) / (1000 * 60 * 60 * 24 * 365.25);
    const rahuLon = ((125.04 - (19.3568 * yearsElapsed)) % 360 + 360) % 360;
    const ketuLon = (rahuLon + 180) % 360;
    const rahu = lonToSign(rahuLon, dateStr);
    const ketu = lonToSign(ketuLon, dateStr);
    return {
      // source:"computed" — mathematically derived from J2000 epoch + mean
      // motion, no fetch involved. Distinct from "jpl" because no ephemeris
      // call was made; flips to "suriyayatra" if/when we add Suriyayatra's
      // own node calculation.
      Rahu: { sign: rahu.sign, degree: rahu.degree, meaning: 'Karmic direction — where growth and challenge intersect', source: 'computed' },
      Ketu: { sign: ketu.sign, degree: ketu.degree, meaning: 'Karmic release — what the soul is moving away from', source: 'computed' },
    };
  } catch (e) {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Geocoding — city cache → Nominatim → country fallback
// ─────────────────────────────────────────────────────────────────────────────
//
// Three-layer fallback. Order matters and was a deliberate fix:
//
//   1. CITY_COORDS exact-match — instant, free, deterministic. Covers ~80%
//      of birthplaces with zero network calls.
//
//   2. Nominatim (OpenStreetMap) — for cities not in our table. Returns the
//      actual city's coordinates, not a country centroid. One retry on
//      timeout. This MUST come before country fallback because inputs like
//      "Allentown, PA, USA" contain "USA" as a substring — letting country
//      fallback match first would return Kansas (USA centroid) and silently
//      compute a lagna 2000 miles off.
//
//   3. COUNTRY_COORDS country fallback — last resort, for inputs that are
//      literally just a country name ("Thailand", "born in the Philippines")
//      or where Nominatim is down. Returns country centroid; for small
//      countries this is tolerable, for large countries it's geographically
//      meaningless. Caller is told (via the `imprecise` flag on the return)
//      so the reading layer can elide rising-sign references when needed.
//
// Returns: { lat, lng, country?, imprecise?, geocodeMethod } | null
//   - lat/lng: coordinates
//   - country: country name when known
//   - imprecise: true when result is a country centroid (caller should not
//     trust the lagna; rising sign and house structure may be unreliable)
//   - geocodeMethod: 'city_cache' | 'nominatim' | 'country_centroid'

const CITY_COORDS = {
  // ── United States ──────────────────────────────────────────────────────
  'new york': { lat: 40.7128, lng: -74.0060, country: 'USA' },
  'new york city': { lat: 40.7128, lng: -74.0060, country: 'USA' },
  'nyc': { lat: 40.7128, lng: -74.0060, country: 'USA' },
  'los angeles': { lat: 34.0522, lng: -118.2437, country: 'USA' },
  'la': { lat: 34.0522, lng: -118.2437, country: 'USA' },
  'chicago': { lat: 41.8781, lng: -87.6298, country: 'USA' },
  'houston': { lat: 29.7604, lng: -95.3698, country: 'USA' },
  'phoenix': { lat: 33.4484, lng: -112.0740, country: 'USA' },
  'philadelphia': { lat: 39.9526, lng: -75.1652, country: 'USA' },
  'philly': { lat: 39.9526, lng: -75.1652, country: 'USA' },
  'san antonio': { lat: 29.4241, lng: -98.4936, country: 'USA' },
  'san diego': { lat: 32.7157, lng: -117.1611, country: 'USA' },
  'dallas': { lat: 32.7767, lng: -96.7970, country: 'USA' },
  'san jose': { lat: 37.3382, lng: -121.8863, country: 'USA' },
  'austin': { lat: 30.2672, lng: -97.7431, country: 'USA' },
  'jacksonville': { lat: 30.3322, lng: -81.6557, country: 'USA' },
  'fort worth': { lat: 32.7555, lng: -97.3308, country: 'USA' },
  'columbus': { lat: 39.9612, lng: -82.9988, country: 'USA' },
  'charlotte': { lat: 35.2271, lng: -80.8431, country: 'USA' },
  'san francisco': { lat: 37.7749, lng: -122.4194, country: 'USA' },
  'sf': { lat: 37.7749, lng: -122.4194, country: 'USA' },
  'indianapolis': { lat: 39.7684, lng: -86.1581, country: 'USA' },
  'seattle': { lat: 47.6062, lng: -122.3321, country: 'USA' },
  'denver': { lat: 39.7392, lng: -104.9903, country: 'USA' },
  'washington': { lat: 38.9072, lng: -77.0369, country: 'USA' },
  'washington dc': { lat: 38.9072, lng: -77.0369, country: 'USA' },
  'nashville': { lat: 36.1627, lng: -86.7816, country: 'USA' },
  'oklahoma city': { lat: 35.4676, lng: -97.5164, country: 'USA' },
  'el paso': { lat: 31.7619, lng: -106.4850, country: 'USA' },
  'boston': { lat: 42.3601, lng: -71.0589, country: 'USA' },
  'portland': { lat: 45.5051, lng: -122.6750, country: 'USA' },
  'las vegas': { lat: 36.1699, lng: -115.1398, country: 'USA' },
  'memphis': { lat: 35.1495, lng: -90.0490, country: 'USA' },
  'louisville': { lat: 38.2527, lng: -85.7585, country: 'USA' },
  'baltimore': { lat: 39.2904, lng: -76.6122, country: 'USA' },
  'milwaukee': { lat: 43.0389, lng: -87.9065, country: 'USA' },
  'albuquerque': { lat: 35.0844, lng: -106.6504, country: 'USA' },
  'tucson': { lat: 32.2226, lng: -110.9747, country: 'USA' },
  'fresno': { lat: 36.7378, lng: -119.7871, country: 'USA' },
  'sacramento': { lat: 38.5816, lng: -121.4944, country: 'USA' },
  'mesa': { lat: 33.4152, lng: -111.8315, country: 'USA' },
  'kansas city': { lat: 39.0997, lng: -94.5786, country: 'USA' },
  'atlanta': { lat: 33.7490, lng: -84.3880, country: 'USA' },
  'omaha': { lat: 41.2565, lng: -95.9345, country: 'USA' },
  'colorado springs': { lat: 38.8339, lng: -104.8214, country: 'USA' },
  'raleigh': { lat: 35.7796, lng: -78.6382, country: 'USA' },
  'long beach': { lat: 33.7701, lng: -118.1937, country: 'USA' },
  'virginia beach': { lat: 36.8529, lng: -75.9780, country: 'USA' },
  'minneapolis': { lat: 44.9778, lng: -93.2650, country: 'USA' },
  'tampa': { lat: 27.9506, lng: -82.4572, country: 'USA' },
  'new orleans': { lat: 29.9511, lng: -90.0715, country: 'USA' },
  'arlington': { lat: 32.7357, lng: -97.1081, country: 'USA' },
  'bakersfield': { lat: 35.3733, lng: -119.0187, country: 'USA' },
  'honolulu': { lat: 21.3069, lng: -157.8583, country: 'USA' },
  'anaheim': { lat: 33.8366, lng: -117.9143, country: 'USA' },
  'aurora': { lat: 39.7294, lng: -104.8319, country: 'USA' },
  'santa ana': { lat: 33.7455, lng: -117.8677, country: 'USA' },
  'corpus christi': { lat: 27.8006, lng: -97.3964, country: 'USA' },
  'riverside': { lat: 33.9806, lng: -117.3755, country: 'USA' },
  'st louis': { lat: 38.6270, lng: -90.1994, country: 'USA' },
  'lexington': { lat: 38.0406, lng: -84.5037, country: 'USA' },
  'pittsburgh': { lat: 40.4406, lng: -79.9959, country: 'USA' },
  'stockton': { lat: 37.9577, lng: -121.2908, country: 'USA' },
  'cincinnati': { lat: 39.1031, lng: -84.5120, country: 'USA' },
  'anchorage': { lat: 61.2181, lng: -149.9003, country: 'USA' },
  'greensboro': { lat: 36.0726, lng: -79.7920, country: 'USA' },
  'plano': { lat: 33.0198, lng: -96.6989, country: 'USA' },
  'newark': { lat: 40.7357, lng: -74.1724, country: 'USA' },
  'henderson': { lat: 36.0395, lng: -114.9817, country: 'USA' },
  'lincoln': { lat: 40.8136, lng: -96.7026, country: 'USA' },
  'buffalo': { lat: 42.8864, lng: -78.8784, country: 'USA' },
  'fort wayne': { lat: 41.1306, lng: -85.1289, country: 'USA' },
  'jersey city': { lat: 40.7178, lng: -74.0431, country: 'USA' },
  'chula vista': { lat: 32.6401, lng: -117.0842, country: 'USA' },
  'orlando': { lat: 28.5383, lng: -81.3792, country: 'USA' },
  'st paul': { lat: 44.9537, lng: -93.0900, country: 'USA' },
  'norfolk': { lat: 36.8508, lng: -76.2859, country: 'USA' },
  'chandler': { lat: 33.3062, lng: -111.8413, country: 'USA' },
  'laredo': { lat: 27.5306, lng: -99.4803, country: 'USA' },
  'madison': { lat: 43.0731, lng: -89.4012, country: 'USA' },
  'durham': { lat: 35.9940, lng: -78.8986, country: 'USA' },
  'lubbock': { lat: 33.5779, lng: -101.8552, country: 'USA' },
  'winston salem': { lat: 36.0999, lng: -80.2442, country: 'USA' },
  'garland': { lat: 32.9126, lng: -96.6389, country: 'USA' },
  'glendale': { lat: 33.5387, lng: -112.1860, country: 'USA' },
  'hialeah': { lat: 25.8576, lng: -80.2781, country: 'USA' },
  'reno': { lat: 39.5296, lng: -119.8138, country: 'USA' },
  'baton rouge': { lat: 30.4515, lng: -91.1871, country: 'USA' },
  'irvine': { lat: 33.6846, lng: -117.8265, country: 'USA' },
  'chesapeake': { lat: 36.7682, lng: -76.2875, country: 'USA' },
  'scottsdale': { lat: 33.4942, lng: -111.9261, country: 'USA' },
  'north las vegas': { lat: 36.1989, lng: -115.1175, country: 'USA' },
  'fremont': { lat: 37.5485, lng: -121.9886, country: 'USA' },
  'gilbert': { lat: 33.3528, lng: -111.7890, country: 'USA' },
  'san bernardino': { lat: 34.1083, lng: -117.2898, country: 'USA' },
  'birmingham': { lat: 33.5207, lng: -86.8025, country: 'USA' },
  'rochester': { lat: 43.1566, lng: -77.6088, country: 'USA' },
  'richmond': { lat: 37.5407, lng: -77.4360, country: 'USA' },
  'spokane': { lat: 47.6588, lng: -117.4260, country: 'USA' },
  'des moines': { lat: 41.5868, lng: -93.6250, country: 'USA' },
  'montgomery': { lat: 32.3792, lng: -86.3077, country: 'USA' },
  'modesto': { lat: 37.6391, lng: -120.9969, country: 'USA' },
  'fayetteville': { lat: 36.0822, lng: -94.1719, country: 'USA' },
  'tacoma': { lat: 47.2529, lng: -122.4443, country: 'USA' },
  'akron': { lat: 41.0814, lng: -81.5190, country: 'USA' },
  'yonkers': { lat: 40.9312, lng: -73.8988, country: 'USA' },
  'mobile': { lat: 30.6954, lng: -88.0399, country: 'USA' },
  'little rock': { lat: 34.7465, lng: -92.2896, country: 'USA' },
  'glendale ca': { lat: 34.1425, lng: -118.2551, country: 'USA' },
  'huntington beach': { lat: 33.6595, lng: -117.9988, country: 'USA' },
  'moreno valley': { lat: 33.9425, lng: -117.2297, country: 'USA' },
  'salt lake city': { lat: 40.7608, lng: -111.8910, country: 'USA' },
  'grand rapids': { lat: 42.9634, lng: -85.6681, country: 'USA' },
  'tallahassee': { lat: 30.4518, lng: -84.2807, country: 'USA' },
  'huntsville': { lat: 34.7304, lng: -86.5861, country: 'USA' },
  'worcester': { lat: 42.2626, lng: -71.8023, country: 'USA' },
  'knoxville': { lat: 35.9606, lng: -83.9207, country: 'USA' },
  'brownsville': { lat: 25.9017, lng: -97.4975, country: 'USA' },
  'santa clarita': { lat: 34.3917, lng: -118.5426, country: 'USA' },
  'providence': { lat: 41.8240, lng: -71.4128, country: 'USA' },
  'garden grove': { lat: 33.7743, lng: -117.9378, country: 'USA' },
  'oceanside': { lat: 33.1959, lng: -117.3795, country: 'USA' },
  'chattanooga': { lat: 35.0456, lng: -85.3097, country: 'USA' },
  'fort lauderdale': { lat: 26.1224, lng: -80.1373, country: 'USA' },
  'rancho cucamonga': { lat: 34.1064, lng: -117.5931, country: 'USA' },
  'santa rosa': { lat: 38.4404, lng: -122.7141, country: 'USA' },
  'munster': { lat: 41.5642, lng: -87.5125, country: 'USA' },
  'detroit': { lat: 42.3314, lng: -83.0458, country: 'USA' },
  'miami': { lat: 25.7617, lng: -80.1918, country: 'USA' },
  'cleveland': { lat: 41.4993, lng: -81.6944, country: 'USA' },
  'tulsa': { lat: 36.1540, lng: -95.9928, country: 'USA' },
  'wichita': { lat: 37.6872, lng: -97.3301, country: 'USA' },
  'hartford': { lat: 41.7658, lng: -72.6851, country: 'USA' },
  'new haven': { lat: 41.3083, lng: -72.9279, country: 'USA' },
  'syracuse': { lat: 43.0481, lng: -76.1474, country: 'USA' },
  'toledo': { lat: 41.6528, lng: -83.5379, country: 'USA' },
  'st petersburg': { lat: 27.7676, lng: -82.6403, country: 'USA' },
  'shreveport': { lat: 32.5252, lng: -93.7502, country: 'USA' },
  'cape coral': { lat: 26.5629, lng: -81.9495, country: 'USA' },

  // ── Canada ─────────────────────────────────────────────────────────────
  'toronto': { lat: 43.6532, lng: -79.3832, country: 'Canada' },
  'montreal': { lat: 45.5017, lng: -73.5673, country: 'Canada' },
  'vancouver': { lat: 49.2827, lng: -123.1207, country: 'Canada' },
  'calgary': { lat: 51.0447, lng: -114.0719, country: 'Canada' },
  'edmonton': { lat: 53.5461, lng: -113.4938, country: 'Canada' },
  'ottawa': { lat: 45.4215, lng: -75.6972, country: 'Canada' },
  'winnipeg': { lat: 49.8951, lng: -97.1384, country: 'Canada' },
  'quebec city': { lat: 46.8139, lng: -71.2080, country: 'Canada' },
  'hamilton': { lat: 43.2557, lng: -79.8711, country: 'Canada' },
  'kitchener': { lat: 43.4516, lng: -80.4925, country: 'Canada' },

  // ── Mexico ─────────────────────────────────────────────────────────────
  'mexico city': { lat: 19.4326, lng: -99.1332, country: 'Mexico' },
  'guadalajara': { lat: 20.6597, lng: -103.3496, country: 'Mexico' },
  'monterrey': { lat: 25.6866, lng: -100.3161, country: 'Mexico' },
  'puebla': { lat: 19.0414, lng: -98.2063, country: 'Mexico' },
  'tijuana': { lat: 32.5149, lng: -117.0382, country: 'Mexico' },
  'cancun': { lat: 21.1619, lng: -86.8515, country: 'Mexico' },

  // ── UK & Ireland ───────────────────────────────────────────────────────
  'london': { lat: 51.5074, lng: -0.1278, country: 'UK' },
  'birmingham uk': { lat: 52.4862, lng: -1.8904, country: 'UK' },
  'manchester': { lat: 53.4808, lng: -2.2426, country: 'UK' },
  'glasgow': { lat: 55.8642, lng: -4.2518, country: 'UK' },
  'liverpool': { lat: 53.4084, lng: -2.9916, country: 'UK' },
  'edinburgh': { lat: 55.9533, lng: -3.1883, country: 'UK' },
  'leeds': { lat: 53.8008, lng: -1.5491, country: 'UK' },
  'sheffield': { lat: 53.3811, lng: -1.4701, country: 'UK' },
  'bristol': { lat: 51.4545, lng: -2.5879, country: 'UK' },
  'dublin': { lat: 53.3498, lng: -6.2603, country: 'Ireland' },
  'cork': { lat: 51.8985, lng: -8.4756, country: 'Ireland' },

  // ── Western Europe ─────────────────────────────────────────────────────
  'paris': { lat: 48.8566, lng: 2.3522, country: 'France' },
  'marseille': { lat: 43.2965, lng: 5.3698, country: 'France' },
  'lyon': { lat: 45.7640, lng: 4.8357, country: 'France' },
  'toulouse': { lat: 43.6047, lng: 1.4442, country: 'France' },
  'nice': { lat: 43.7102, lng: 7.2620, country: 'France' },
  'berlin': { lat: 52.5200, lng: 13.4050, country: 'Germany' },
  'hamburg': { lat: 53.5753, lng: 10.0153, country: 'Germany' },
  'munich': { lat: 48.1351, lng: 11.5820, country: 'Germany' },
  'cologne': { lat: 50.9333, lng: 6.9500, country: 'Germany' },
  'frankfurt': { lat: 50.1109, lng: 8.6821, country: 'Germany' },
  'amsterdam': { lat: 52.3676, lng: 4.9041, country: 'Netherlands' },
  'rotterdam': { lat: 51.9225, lng: 4.4792, country: 'Netherlands' },
  'brussels': { lat: 50.8503, lng: 4.3517, country: 'Belgium' },
  'madrid': { lat: 40.4168, lng: -3.7038, country: 'Spain' },
  'barcelona': { lat: 41.3851, lng: 2.1734, country: 'Spain' },
  'valencia': { lat: 39.4699, lng: -0.3763, country: 'Spain' },
  'seville': { lat: 37.3891, lng: -5.9845, country: 'Spain' },
  'lisbon': { lat: 38.7223, lng: -9.1393, country: 'Portugal' },
  'porto': { lat: 41.1579, lng: -8.6291, country: 'Portugal' },
  'rome': { lat: 41.9028, lng: 12.4964, country: 'Italy' },
  'milan': { lat: 45.4654, lng: 9.1859, country: 'Italy' },
  'naples': { lat: 40.8518, lng: 14.2681, country: 'Italy' },
  'turin': { lat: 45.0703, lng: 7.6869, country: 'Italy' },
  'florence': { lat: 43.7696, lng: 11.2558, country: 'Italy' },
  'venice': { lat: 45.4408, lng: 12.3155, country: 'Italy' },
  'zurich': { lat: 47.3769, lng: 8.5417, country: 'Switzerland' },
  'geneva': { lat: 46.2044, lng: 6.1432, country: 'Switzerland' },
  'vienna': { lat: 48.2082, lng: 16.3738, country: 'Austria' },
  'stockholm': { lat: 59.3293, lng: 18.0686, country: 'Sweden' },
  'oslo': { lat: 59.9139, lng: 10.7522, country: 'Norway' },
  'copenhagen': { lat: 55.6761, lng: 12.5683, country: 'Denmark' },
  'helsinki': { lat: 60.1699, lng: 24.9384, country: 'Finland' },
  'athens': { lat: 37.9838, lng: 23.7275, country: 'Greece' },
  'warsaw': { lat: 52.2297, lng: 21.0122, country: 'Poland' },
  'prague': { lat: 50.0755, lng: 14.4378, country: 'Czech Republic' },
  'budapest': { lat: 47.4979, lng: 19.0402, country: 'Hungary' },
  'bucharest': { lat: 44.4268, lng: 26.1025, country: 'Romania' },
  'sofia': { lat: 42.6977, lng: 23.3219, country: 'Bulgaria' },
  'zagreb': { lat: 45.8150, lng: 15.9819, country: 'Croatia' },
  'belgrade': { lat: 44.7866, lng: 20.4489, country: 'Serbia' },

  // ── Eastern Europe & Russia ────────────────────────────────────────────
  'moscow': { lat: 55.7558, lng: 37.6173, country: 'Russia' },
  'st petersburg russia': { lat: 59.9311, lng: 30.3609, country: 'Russia' },
  'kiev': { lat: 50.4501, lng: 30.5234, country: 'Ukraine' },
  'kyiv': { lat: 50.4501, lng: 30.5234, country: 'Ukraine' },
  'minsk': { lat: 53.9045, lng: 27.5615, country: 'Belarus' },
  'istanbul': { lat: 41.0082, lng: 28.9784, country: 'Turkey' },
  'ankara': { lat: 39.9334, lng: 32.8597, country: 'Turkey' },

  // ── Middle East ────────────────────────────────────────────────────────
  'dubai': { lat: 25.2048, lng: 55.2708, country: 'UAE' },
  'abu dhabi': { lat: 24.4539, lng: 54.3773, country: 'UAE' },
  'riyadh': { lat: 24.6877, lng: 46.7219, country: 'Saudi Arabia' },
  'jeddah': { lat: 21.5433, lng: 39.1728, country: 'Saudi Arabia' },
  'mecca': { lat: 21.3891, lng: 39.8579, country: 'Saudi Arabia' },
  'doha': { lat: 25.2854, lng: 51.5310, country: 'Qatar' },
  'kuwait city': { lat: 29.3759, lng: 47.9774, country: 'Kuwait' },
  'manama': { lat: 26.2235, lng: 50.5876, country: 'Bahrain' },
  'muscat': { lat: 23.5859, lng: 58.4059, country: 'Oman' },
  'amman': { lat: 31.9454, lng: 35.9284, country: 'Jordan' },
  'beirut': { lat: 33.8938, lng: 35.5018, country: 'Lebanon' },
  'damascus': { lat: 33.5138, lng: 36.2765, country: 'Syria' },
  'baghdad': { lat: 33.3152, lng: 44.3661, country: 'Iraq' },
  'tehran': { lat: 35.6892, lng: 51.3890, country: 'Iran' },
  'tel aviv': { lat: 32.0853, lng: 34.7818, country: 'Israel' },
  'jerusalem': { lat: 31.7683, lng: 35.2137, country: 'Israel' },

  // ── Africa ─────────────────────────────────────────────────────────────
  'cairo': { lat: 30.0444, lng: 31.2357, country: 'Egypt' },
  'alexandria': { lat: 31.2001, lng: 29.9187, country: 'Egypt' },
  'lagos': { lat: 6.5244, lng: 3.3792, country: 'Nigeria' },
  'abuja': { lat: 9.0765, lng: 7.3986, country: 'Nigeria' },
  'johannesburg': { lat: -26.2041, lng: 28.0473, country: 'South Africa' },
  'cape town': { lat: -33.9249, lng: 18.4241, country: 'South Africa' },
  'durban': { lat: -29.8587, lng: 31.0218, country: 'South Africa' },
  'nairobi': { lat: -1.2921, lng: 36.8219, country: 'Kenya' },
  'addis ababa': { lat: 9.0320, lng: 38.7469, country: 'Ethiopia' },
  'dar es salaam': { lat: -6.7924, lng: 39.2083, country: 'Tanzania' },
  'accra': { lat: 5.6037, lng: -0.1870, country: 'Ghana' },
  'casablanca': { lat: 33.5731, lng: -7.5898, country: 'Morocco' },
  'tunis': { lat: 36.8190, lng: 10.1658, country: 'Tunisia' },
  'algiers': { lat: 36.7372, lng: 3.0865, country: 'Algeria' },
  'khartoum': { lat: 15.5518, lng: 32.5324, country: 'Sudan' },
  'kampala': { lat: 0.3476, lng: 32.5825, country: 'Uganda' },
  'dakar': { lat: 14.7167, lng: -17.4677, country: 'Senegal' },
  'kinshasa': { lat: -4.4419, lng: 15.2663, country: 'DRC' },
  'luanda': { lat: -8.8368, lng: 13.2343, country: 'Angola' },
  'harare': { lat: -17.8292, lng: 31.0522, country: 'Zimbabwe' },
  'antananarivo': { lat: -18.9137, lng: 47.5361, country: 'Madagascar' },

  // ── South Asia ─────────────────────────────────────────────────────────
  'mumbai': { lat: 19.0760, lng: 72.8777, country: 'India' },
  'bombay': { lat: 19.0760, lng: 72.8777, country: 'India' },
  'delhi': { lat: 28.7041, lng: 77.1025, country: 'India' },
  'new delhi': { lat: 28.6139, lng: 77.2090, country: 'India' },
  'bangalore': { lat: 12.9716, lng: 77.5946, country: 'India' },
  'bengaluru': { lat: 12.9716, lng: 77.5946, country: 'India' },
  'hyderabad': { lat: 17.3850, lng: 78.4867, country: 'India' },
  'ahmedabad': { lat: 23.0225, lng: 72.5714, country: 'India' },
  'chennai': { lat: 13.0827, lng: 80.2707, country: 'India' },
  'madras': { lat: 13.0827, lng: 80.2707, country: 'India' },
  'kolkata': { lat: 22.5726, lng: 88.3639, country: 'India' },
  'calcutta': { lat: 22.5726, lng: 88.3639, country: 'India' },
  'pune': { lat: 18.5204, lng: 73.8567, country: 'India' },
  'jaipur': { lat: 26.9124, lng: 75.7873, country: 'India' },
  'surat': { lat: 21.1702, lng: 72.8311, country: 'India' },
  'lucknow': { lat: 26.8467, lng: 80.9462, country: 'India' },
  'kanpur': { lat: 26.4499, lng: 80.3319, country: 'India' },
  'nagpur': { lat: 21.1458, lng: 79.0882, country: 'India' },
  'karachi': { lat: 24.8607, lng: 67.0011, country: 'Pakistan' },
  'lahore': { lat: 31.5204, lng: 74.3587, country: 'Pakistan' },
  'islamabad': { lat: 33.6844, lng: 73.0479, country: 'Pakistan' },
  'dhaka': { lat: 23.8103, lng: 90.4125, country: 'Bangladesh' },
  'chittagong': { lat: 22.3569, lng: 91.7832, country: 'Bangladesh' },
  'colombo': { lat: 6.9271, lng: 79.8612, country: 'Sri Lanka' },
  'kathmandu': { lat: 27.7172, lng: 85.3240, country: 'Nepal' },

  // ── Southeast Asia ─────────────────────────────────────────────────────
  'bangkok': { lat: 13.7563, lng: 100.5018, country: 'Thailand' },
  'chiang mai': { lat: 18.7883, lng: 98.9853, country: 'Thailand' },
  'phuket': { lat: 7.8804, lng: 98.3923, country: 'Thailand' },
  'pattaya': { lat: 12.9236, lng: 100.8825, country: 'Thailand' },
  'hat yai': { lat: 7.0061, lng: 100.4772, country: 'Thailand' },
  'vientiane': { lat: 17.9757, lng: 102.6331, country: 'Laos' },
  'luang prabang': { lat: 19.8845, lng: 102.1347, country: 'Laos' },
  'phnom penh': { lat: 11.5564, lng: 104.9282, country: 'Cambodia' },
  'siem reap': { lat: 13.3633, lng: 103.8564, country: 'Cambodia' },
  'ho chi minh': { lat: 10.8231, lng: 106.6297, country: 'Vietnam' },
  'saigon': { lat: 10.8231, lng: 106.6297, country: 'Vietnam' },
  'hanoi': { lat: 21.0285, lng: 105.8542, country: 'Vietnam' },
  'da nang': { lat: 16.0544, lng: 108.2022, country: 'Vietnam' },
  'yangon': { lat: 16.8661, lng: 96.1951, country: 'Myanmar' },
  'mandalay': { lat: 21.9588, lng: 96.0891, country: 'Myanmar' },
  'naypyidaw': { lat: 19.7633, lng: 96.0785, country: 'Myanmar' },
  'kuala lumpur': { lat: 3.1390, lng: 101.6869, country: 'Malaysia' },
  'penang': { lat: 5.4141, lng: 100.3288, country: 'Malaysia' },
  'singapore': { lat: 1.3521, lng: 103.8198, country: 'Singapore' },
  'jakarta': { lat: -6.2088, lng: 106.8456, country: 'Indonesia' },
  'surabaya': { lat: -7.2575, lng: 112.7521, country: 'Indonesia' },
  'bali': { lat: -8.4095, lng: 115.1889, country: 'Indonesia' },
  'denpasar': { lat: -8.6705, lng: 115.2126, country: 'Indonesia' },
  'medan': { lat: 3.5952, lng: 98.6722, country: 'Indonesia' },
  'bandung': { lat: -6.9175, lng: 107.6191, country: 'Indonesia' },
  'manila': { lat: 14.5995, lng: 120.9842, country: 'Philippines' },
  'cebu': { lat: 10.3157, lng: 123.8854, country: 'Philippines' },
  'davao': { lat: 7.1907, lng: 125.4553, country: 'Philippines' },

  // ── East Asia ──────────────────────────────────────────────────────────
  'tokyo': { lat: 35.6762, lng: 139.6503, country: 'Japan' },
  'osaka': { lat: 34.6937, lng: 135.5023, country: 'Japan' },
  'kyoto': { lat: 35.0116, lng: 135.7681, country: 'Japan' },
  'yokohama': { lat: 35.4437, lng: 139.6380, country: 'Japan' },
  'nagoya': { lat: 35.1815, lng: 136.9066, country: 'Japan' },
  'sapporo': { lat: 43.0618, lng: 141.3545, country: 'Japan' },
  'fukuoka': { lat: 33.5904, lng: 130.4017, country: 'Japan' },
  'beijing': { lat: 39.9042, lng: 116.4074, country: 'China' },
  'shanghai': { lat: 31.2304, lng: 121.4737, country: 'China' },
  'guangzhou': { lat: 23.1291, lng: 113.2644, country: 'China' },
  'shenzhen': { lat: 22.5431, lng: 114.0579, country: 'China' },
  'chengdu': { lat: 30.5728, lng: 104.0668, country: 'China' },
  'tianjin': { lat: 39.3434, lng: 117.3616, country: 'China' },
  'wuhan': { lat: 30.5928, lng: 114.3052, country: 'China' },
  'xian': { lat: 34.3416, lng: 108.9398, country: 'China' },
  'hong kong': { lat: 22.3193, lng: 114.1694, country: 'Hong Kong' },
  'macau': { lat: 22.1987, lng: 113.5439, country: 'Macau' },
  'taipei': { lat: 25.0330, lng: 121.5654, country: 'Taiwan' },
  'seoul': { lat: 37.5665, lng: 126.9780, country: 'South Korea' },
  'busan': { lat: 35.1796, lng: 129.0756, country: 'South Korea' },
  'incheon': { lat: 37.4563, lng: 126.7052, country: 'South Korea' },
  'pyongyang': { lat: 39.0392, lng: 125.7625, country: 'North Korea' },
  'ulaanbaatar': { lat: 47.8864, lng: 106.9057, country: 'Mongolia' },

  // ── Central Asia ───────────────────────────────────────────────────────
  'almaty': { lat: 43.2220, lng: 76.8512, country: 'Kazakhstan' },
  'nur-sultan': { lat: 51.1801, lng: 71.4460, country: 'Kazakhstan' },
  'astana': { lat: 51.1801, lng: 71.4460, country: 'Kazakhstan' },
  'tashkent': { lat: 41.2995, lng: 69.2401, country: 'Uzbekistan' },

  // ── Oceania ────────────────────────────────────────────────────────────
  'sydney': { lat: -33.8688, lng: 151.2093, country: 'Australia' },
  'melbourne': { lat: -37.8136, lng: 144.9631, country: 'Australia' },
  'brisbane': { lat: -27.4698, lng: 153.0251, country: 'Australia' },
  'perth': { lat: -31.9505, lng: 115.8605, country: 'Australia' },
  'adelaide': { lat: -34.9285, lng: 138.6007, country: 'Australia' },
  'gold coast': { lat: -28.0167, lng: 153.4000, country: 'Australia' },
  'auckland': { lat: -36.8509, lng: 174.7645, country: 'New Zealand' },
  'wellington': { lat: -41.2865, lng: 174.7762, country: 'New Zealand' },
  'christchurch': { lat: -43.5321, lng: 172.6362, country: 'New Zealand' },

  // ── South America ──────────────────────────────────────────────────────
  'sao paulo': { lat: -23.5505, lng: -46.6333, country: 'Brazil' },
  'rio de janeiro': { lat: -22.9068, lng: -43.1729, country: 'Brazil' },
  'rio': { lat: -22.9068, lng: -43.1729, country: 'Brazil' },
  'brasilia': { lat: -15.8267, lng: -47.9218, country: 'Brazil' },
  'salvador': { lat: -12.9714, lng: -38.5014, country: 'Brazil' },
  'fortaleza': { lat: -3.7319, lng: -38.5267, country: 'Brazil' },
  'buenos aires': { lat: -34.6037, lng: -58.3816, country: 'Argentina' },
  'cordoba argentina': { lat: -31.4201, lng: -64.1888, country: 'Argentina' },
  'rosario': { lat: -32.9442, lng: -60.6505, country: 'Argentina' },
  'santiago': { lat: -33.4489, lng: -70.6693, country: 'Chile' },
  'lima': { lat: -12.0464, lng: -77.0428, country: 'Peru' },
  'bogota': { lat: 4.7110, lng: -74.0721, country: 'Colombia' },
  'medellin': { lat: 6.2442, lng: -75.5812, country: 'Colombia' },
  'cali': { lat: 3.4516, lng: -76.5320, country: 'Colombia' },
  'caracas': { lat: 10.4806, lng: -66.9036, country: 'Venezuela' },
  'quito': { lat: -0.1807, lng: -78.4678, country: 'Ecuador' },
  'la paz': { lat: -16.5000, lng: -68.1500, country: 'Bolivia' },
  'asuncion': { lat: -25.2867, lng: -57.6470, country: 'Paraguay' },
  'montevideo': { lat: -34.9011, lng: -56.1645, country: 'Uruguay' },

  // ── Caribbean & Central America ────────────────────────────────────────
  'havana': { lat: 23.1136, lng: -82.3666, country: 'Cuba' },
  'san juan': { lat: 18.4655, lng: -66.1057, country: 'Puerto Rico' },
  'santo domingo': { lat: 18.4861, lng: -69.9312, country: 'Dominican Republic' },
  'port au prince': { lat: 18.5944, lng: -72.3074, country: 'Haiti' },
  'kingston': { lat: 17.9970, lng: -76.7936, country: 'Jamaica' },
  'panama city': { lat: 8.9936, lng: -79.5197, country: 'Panama' },
  'san jose cr': { lat: 9.9281, lng: -84.0907, country: 'Costa Rica' },
  'guatemala city': { lat: 14.6349, lng: -90.5069, country: 'Guatemala' },
  'tegucigalpa': { lat: 14.0723, lng: -87.2073, country: 'Honduras' },
  'managua': { lat: 12.1328, lng: -86.2504, country: 'Nicaragua' },
  'san salvador': { lat: 13.6929, lng: -89.2182, country: 'El Salvador' },
};

const COUNTRY_COORDS = {
  'usa': { lat: 38.0, lng: -97.0, country: 'USA' },
  'united states': { lat: 38.0, lng: -97.0, country: 'USA' },
  'thailand': { lat: 15.87, lng: 100.99, country: 'Thailand' },
  'laos': { lat: 19.86, lng: 102.50, country: 'Laos' },
  'vietnam': { lat: 14.06, lng: 108.28, country: 'Vietnam' },
  'cambodia': { lat: 12.57, lng: 104.99, country: 'Cambodia' },
  'myanmar': { lat: 19.15, lng: 95.96, country: 'Myanmar' },
  'indonesia': { lat: -0.79, lng: 113.92, country: 'Indonesia' },
  'malaysia': { lat: 4.21, lng: 108.96, country: 'Malaysia' },
  'philippines': { lat: 12.88, lng: 121.77, country: 'Philippines' },
  'india': { lat: 20.59, lng: 78.96, country: 'India' },
  'china': { lat: 35.86, lng: 104.20, country: 'China' },
  'japan': { lat: 36.20, lng: 138.25, country: 'Japan' },
  'south korea': { lat: 35.91, lng: 127.77, country: 'South Korea' },
  'uk': { lat: 55.38, lng: -3.44, country: 'UK' },
  'france': { lat: 46.23, lng: 2.21, country: 'France' },
  'germany': { lat: 51.17, lng: 10.45, country: 'Germany' },
  'egypt': { lat: 26.82, lng: 30.80, country: 'Egypt' },
  'australia': { lat: -25.27, lng: 133.78, country: 'Australia' },
  'canada': { lat: 56.13, lng: -106.35, country: 'Canada' },
  'mexico': { lat: 23.63, lng: -102.55, country: 'Mexico' },
  'brazil': { lat: -14.24, lng: -51.93, country: 'Brazil' },
  'nigeria': { lat: 9.08, lng: 8.68, country: 'Nigeria' },
  'south africa': { lat: -30.56, lng: 22.94, country: 'South Africa' },
};

// Try Nominatim once, with timeout. Returns coords or null. Doesn't throw —
// any failure (timeout, network, empty results, malformed JSON) returns null
// so the caller can fall through to country fallback.
async function tryNominatim(birthplace, timeoutMs) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(birthplace)}&format=json&limit=1`;
    const fetchP = fetch(url, {
      headers: { 'User-Agent': 'MorDoo/1.0 (mordoo-sepia.vercel.app)' }
    }).then(r => r.json());
    const timeoutP = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Nominatim timeout')), timeoutMs)
    );
    const data = await Promise.race([fetchP, timeoutP]);
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function geocode(birthplace) {
  if (!birthplace) return null;
  const normalized = birthplace.toLowerCase().trim()
    .replace(/[,\.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Tokenize for word-boundary matching. Naive .includes() matches "la" inside
  // "phi-la-delphia" and returns Los Angeles for Philadelphia — a bug inherited
  // from chat.js. Tokenizing on whitespace fixes this: city keys with multiple
  // words still work (e.g. "new york", "ho chi minh") because we test each
  // multi-word key as an n-gram against the token list.
  const tokens = normalized.split(' ').filter(t => t.length > 0);
  const matchesAsTokens = (cityKey) => {
    const cityTokens = cityKey.split(' ');
    if (cityTokens.length === 1) {
      return tokens.includes(cityTokens[0]);
    }
    // Multi-word city: check if cityTokens appear as a contiguous run.
    for (let i = 0; i <= tokens.length - cityTokens.length; i++) {
      let match = true;
      for (let j = 0; j < cityTokens.length; j++) {
        if (tokens[i + j] !== cityTokens[j]) { match = false; break; }
      }
      if (match) return true;
    }
    return false;
  };

  // 1. City cache — instant, deterministic, covers common cases.
  // Iterate longest-key-first so "new york city" wins over "new york",
  // and "ho chi minh" wins over partial matches.
  const cityKeysSorted = Object.keys(CITY_COORDS).sort((a, b) => b.length - a.length);
  for (const city of cityKeysSorted) {
    if (matchesAsTokens(city)) {
      return { ...CITY_COORDS[city], geocodeMethod: 'city_cache' };
    }
  }

  // 2. Nominatim — try first with 5s timeout, retry once with 5s on failure.
  // Total budget ≤10s. Comes BEFORE country fallback so inputs like
  // "Allentown, PA, USA" return Allentown, not Kansas.
  let nominatimResult = await tryNominatim(birthplace, 5000);
  if (!nominatimResult) {
    console.log('[geocode] Nominatim first attempt failed, retrying:', birthplace);
    nominatimResult = await tryNominatim(birthplace, 5000);
  }
  if (nominatimResult) {
    return { ...nominatimResult, geocodeMethod: 'nominatim' };
  }

  // 3. Country fallback — last resort. Country centroid is geographically
  // imprecise; for big countries (USA, Russia, China) the lagna will be
  // unreliable and we flag the result so the reading can elide rising-sign
  // references when needed.
  const countryKeysSorted = Object.keys(COUNTRY_COORDS).sort((a, b) => b.length - a.length);
  for (const country of countryKeysSorted) {
    if (matchesAsTokens(country)) {
      console.log(`[geocode] falling back to country centroid: ${country} (Nominatim failed)`);
      return { ...COUNTRY_COORDS[country], imprecise: true, geocodeMethod: 'country_centroid' };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ascendant (lagna) — Antonati Saman + trigonometric, hybrid merge
// ─────────────────────────────────────────────────────────────────────────────

// NOAA sunrise approximation in local hours (decimal). Accurate to ~1 min for
// non-polar latitudes — well within the 24-min antonati table resolution.
// Verified against myhora.com for Welmanee (06:39 sunrise, 1992-02-26 Phila).
function localSunriseHour(year, month, day, lat, lng, utcOffsetHours) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const start = new Date(Date.UTC(year, 0, 1));
  const N = Math.floor((date - start) / (24 * 60 * 60 * 1000)) + 1;
  const lngHour = lng / 15;
  const t = N + (6 - lngHour) / 24;
  const M = (0.9856 * t) - 3.289;
  let L = M + (1.916 * Math.sin(M * Math.PI / 180)) + (0.020 * Math.sin(2 * M * Math.PI / 180)) + 282.634;
  L = ((L % 360) + 360) % 360;
  let RA = Math.atan(0.91764 * Math.tan(L * Math.PI / 180)) * 180 / Math.PI;
  RA = ((RA % 360) + 360) % 360;
  const Lq = Math.floor(L / 90) * 90;
  const RAq = Math.floor(RA / 90) * 90;
  RA = (RA + (Lq - RAq)) / 15;
  const sinDec = 0.39782 * Math.sin(L * Math.PI / 180);
  const cosDec = Math.cos(Math.asin(sinDec));
  const zenith = 90.833;
  const cosH = (Math.cos(zenith * Math.PI / 180) - sinDec * Math.sin(lat * Math.PI / 180))
             / (cosDec * Math.cos(lat * Math.PI / 180));
  if (cosH > 1 || cosH < -1) return null;
  const H = (360 - Math.acos(cosH) * 180 / Math.PI) / 15;
  const T = H + RA - (0.06571 * t) - 6.622;
  let UT = T - lngHour;
  UT = ((UT % 24) + 24) % 24;
  return ((UT + utcOffsetHours) % 24 + 24) % 24;
}

// Antonati Saman lagna (Thai traditional method). Walks the rise-time table
// from the most recent sunrise, anchored on the sun's sidereal position.
// Reproduces myhora.com's Libra 28°53' for Welmanee exactly.
function antonatiAscendant(jplDate, lat, lng, utcOffsetHours, birthHour, birthMin, sunSiderealLon) {
  if (sunSiderealLon === null || sunSiderealLon === undefined) return null;
  const [y, m, d] = jplDate.split('-').map(Number);

  const sunriseHour = localSunriseHour(y, m, d, lat, lng, utcOffsetHours);
  if (sunriseHour === null) return null;

  // Birth before sunrise → use previous day's sunrise as anchor (approximated
  // to same time; sunrise drifts < 2 min/day at most latitudes, worst-case
  // error ~0.5° of lagna).
  const birthLocalHour = birthHour + birthMin / 60;
  let elapsedMin;
  if (birthLocalHour >= sunriseHour) {
    elapsedMin = (birthLocalHour - sunriseHour) * 60;
  } else {
    elapsedMin = (24 - sunriseHour + birthLocalHour) * 60;
  }

  const sunSignIdx = Math.floor(sunSiderealLon / 30);
  const sunDegInSign = sunSiderealLon % 30;
  let signIdx = sunSignIdx;

  // Time for lagna to finish the sun's current sign.
  const fractionRemaining = (30 - sunDegInSign) / 30;
  const timeToFinishSunSign = ANTONATI_MINUTES[signIdx] * fractionRemaining;

  let remainingMin = elapsedMin;
  let lagnaDeg;

  if (remainingMin <= timeToFinishSunSign) {
    const usedFraction = remainingMin / ANTONATI_MINUTES[signIdx];
    lagnaDeg = sunDegInSign + usedFraction * 30;
  } else {
    remainingMin -= timeToFinishSunSign;
    signIdx = (signIdx + 1) % 12;
    let safety = 24;  // can't loop more than full circle
    while (remainingMin >= ANTONATI_MINUTES[signIdx] && safety-- > 0) {
      remainingMin -= ANTONATI_MINUTES[signIdx];
      signIdx = (signIdx + 1) % 12;
    }
    lagnaDeg = (remainingMin / ANTONATI_MINUTES[signIdx]) * 30;
  }

  return {
    sign: ZODIAC_SIGNS[signIdx],
    degree: Math.floor(lagnaDeg),
    fractional: lagnaDeg,
    method: 'antonati',
  };
}

// Hybrid lagna policy: compute both methods, prefer trigonometric's degree
// when signs agree, defer to Antonati when they disagree (always near a
// cusp). Customers check Thai sites — Antonati wins ties so our app agrees
// with myhora.com when it counts.
function computeAscendant(jplDate, birthtime, coords, sunInfo) {
  if (!birthtime || !coords) return null;
  try {
    const tMatch = String(birthtime).match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!tMatch) return null;

    let hr = parseInt(tMatch[1]);
    const mn = parseInt(tMatch[2]);
    const ap = (tMatch[3] || '').toLowerCase();
    if (ap === 'pm' && hr !== 12) hr += 12;
    if (ap === 'am' && hr === 12) hr = 0;

    // UTC offset estimated from longitude (15°/hr), rounded to nearest hour.
    // Real offsets are quantized to whole or half hours; rounding averages
    // out longitude noise (Phila -75.165° → -5.011 → -5, exact EST). Wrong
    // by a known integer offset for places where legal TZ diverges from
    // longitude (Paris, much of China), still better than ~0.16° GST drift.
    const utcOffset = Math.round(coords.lng / 15);
    const utcHour = hr - utcOffset + mn / 60;
    const [y, m, d] = jplDate.split('-').map(Number);

    // Trigonometric ascendant (Meeus AA Ch.13)
    const JD = 367*y - Math.floor(7*(y+Math.floor((m+9)/12))/4) +
      Math.floor(275*m/9) + d + 1721013.5 + utcHour/24;
    const T = (JD - 2451545.0) / 36525;
    let GST = 280.46061837 + 360.98564736629*(JD-2451545) + 0.000387933*T*T;
    GST = ((GST % 360) + 360) % 360;
    const LST = ((GST + coords.lng) % 360 + 360) % 360;
    const latRad = coords.lat * Math.PI / 180;
    const lstRad = LST * Math.PI / 180;
    const e = 23.4397 * Math.PI / 180;
    let asc = Math.atan2(Math.cos(lstRad), -(Math.sin(lstRad)*Math.cos(e) + Math.tan(latRad)*Math.sin(e)));
    asc = ((asc * 180 / Math.PI) % 360 + 360) % 360;
    const ayanAsc = getLahiriAyanamsa(jplDate);
    asc = ((asc - ayanAsc) % 360 + 360) % 360;
    const trigAsc = {
      sign: ZODIAC_SIGNS[Math.floor(asc/30)],
      degree: Math.floor(asc % 30),
      fractional: asc % 30,
      method: 'trigonometric',
    };

    // Antonati ascendant (Thai canon)
    let antoAsc = null;
    if (sunInfo && sunInfo.sign && typeof sunInfo.degree === 'number') {
      const sunSignIdx = ZODIAC_SIGNS.indexOf(sunInfo.sign);
      if (sunSignIdx !== -1) {
        const sunSiderealLon = sunSignIdx * 30 + sunInfo.degree;
        antoAsc = antonatiAscendant(jplDate, coords.lat, coords.lng,
          utcOffset, hr, mn, sunSiderealLon);
      }
    }

    // Hybrid merge
    if (!antoAsc) {
      return trigAsc;
    } else if (antoAsc.sign === trigAsc.sign) {
      return { sign: trigAsc.sign, degree: trigAsc.degree, method: 'agree' };
    } else {
      // Disagreement = always near a cusp. Trust Antonati (Thai canon).
      console.log(`[lagna] cusp disagreement ${jplDate}: trig=${trigAsc.sign} ${trigAsc.degree}°, anto=${antoAsc.sign} ${antoAsc.degree}° → antonati`);
      return {
        sign: antoAsc.sign,
        degree: antoAsc.degree,
        method: 'antonati_cusp',
        trigSign: trigAsc.sign,    // diagnostic only; client doesn't show
        trigDegree: trigAsc.degree,
      };
    }
  } catch (e) {
    console.error('[lagna] error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// House structure — whole-sign, lagna-anchored
// ─────────────────────────────────────────────────────────────────────────────
//
// Whole-sign houses: house 1 = lagna's sign, house 2 = next sign, ...
// This is the Thai-traditional system (also the oldest Vedic system) and
// matches what myhora.com produces. Verified against Welmanee's chart —
// all 9 placements reproduce exactly.

function buildHouseMap(lagnaSign) {
  const lagnaIdx = ZODIAC_SIGNS.indexOf(lagnaSign);
  if (lagnaIdx === -1) return null;
  const map = {};
  for (let i = 0; i < 12; i++) {
    map[ZODIAC_SIGNS[(lagnaIdx + i) % 12]] = i + 1;
  }
  return map;
}

function computeHouseStructure(chart, rahuKetu, lagnaSign) {
  if (!lagnaSign) return null;
  const houseMap = buildHouseMap(lagnaSign);
  if (!houseMap) return null;

  const houseOfPlanet = {};
  for (const [p, data] of Object.entries(chart || {})) {
    if (p.startsWith('__')) continue; // skip non-enumerable metadata leaks
    if (data && data.sign && houseMap[data.sign]) {
      houseOfPlanet[p] = houseMap[data.sign];
    }
  }
  if (rahuKetu) {
    for (const [node, data] of Object.entries(rahuKetu)) {
      if (data && data.sign && houseMap[data.sign]) {
        houseOfPlanet[node] = houseMap[data.sign];
      }
    }
  }

  const signInHouse = {};
  for (const [sign, h] of Object.entries(houseMap)) signInHouse[h] = sign;

  const lordOfHouse = {};
  for (let h = 1; h <= 12; h++) lordOfHouse[h] = SIGN_LORD[signInHouse[h]];

  // The 12 lord-in-house facts. Each tells you "the planet that runs life
  // domain X is currently doing its work in life domain Y" — the most
  // interpretively rich data point in the chart. The 1st entry (lord of
  // lagna) is the chart's primary identity statement.
  const lordPlacements = [];
  for (let h = 1; h <= 12; h++) {
    const lord = lordOfHouse[h];
    const lordIn = houseOfPlanet[lord]; // may be undefined if planet failed to fetch
    lordPlacements.push({
      house: h,
      lord,
      lordIn: lordIn || null,
      lordSign: chart && chart[lord] ? chart[lord].sign : null,
      houseMeaning: HOUSE_MEANING[h],
      lordInMeaning: lordIn ? HOUSE_MEANING[lordIn] : null,
    });
  }

  return { houseOfPlanet, lordOfHouse, signInHouse, lordPlacements };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convergence detection — patterns where multiple layers point at one theme
// ─────────────────────────────────────────────────────────────────────────────
//
// These are signatures, not facts. The model uses them as starting points
// for synthesis; without them it has to discover convergences from raw
// placements (which it does badly). Currently detects:
//   1. Planet saturation — a planet across 3+ independent layers
//   2. Stellium — 3+ planets in same sign
//   3. Dignity balance — overall chart strength
//   4. Lagna lord house-type — primary identity location signal
//
// All synthesis strings use lived language only.

function detectConvergences(chart, rahuKetu, houses, dayOfWeekRuler) {
  const findings = [];
  if (!chart) return findings;

  // 1. Planet saturation
  const planetWeights = {};
  const noteLayer = (planet, layer) => {
    if (!planet) return;
    if (!planetWeights[planet]) planetWeights[planet] = [];
    planetWeights[planet].push(layer);
  };
  if (dayOfWeekRuler) noteLayer(dayOfWeekRuler, 'day-of-week ruler');
  if (houses && houses.lordPlacements && houses.lordPlacements[0]) {
    noteLayer(houses.lordPlacements[0].lord, 'lagna lord');
  }
  if (chart.Sun && chart.Sun.sign) {
    noteLayer(SIGN_LORD[chart.Sun.sign], 'sun-sign ruler');
  }
  for (const [p, d] of Object.entries(chart)) {
    if (p.startsWith('__')) continue;
    if (d && d.dignity && (d.dignity.includes('exalted') || d.dignity.includes('own sign'))) {
      noteLayer(p, `${d.dignity} in ${d.sign}`);
    }
  }
  for (const [planet, layers] of Object.entries(planetWeights)) {
    if (layers.length >= 3) {
      findings.push({
        type: 'planet_saturation',
        planet,
        layers,
        synthesis: `${planet} reinforces across ${layers.length} independent layers (${layers.join(', ')}). This is a saturation signature — the chart fundamentally runs on ${planet}'s frequency.`,
      });
    }
  }

  // 2. Stellium
  const planetsBySign = {};
  for (const [p, d] of Object.entries(chart)) {
    if (p.startsWith('__')) continue;
    if (d && d.sign) {
      if (!planetsBySign[d.sign]) planetsBySign[d.sign] = [];
      planetsBySign[d.sign].push(p);
    }
  }
  for (const [sign, planets] of Object.entries(planetsBySign)) {
    if (planets.length >= 3) {
      const houseOfSign = houses && houses.houseOfPlanet && houses.houseOfPlanet[planets[0]];
      const houseMean = houses && houses.lordPlacements && houseOfSign
        && houses.lordPlacements[houseOfSign-1]
        ? houses.lordPlacements[houseOfSign-1].houseMeaning : null;
      findings.push({
        type: 'stellium',
        sign,
        planets,
        houseOfStellium: houseOfSign,
        houseMeaning: houseMean,
        synthesis: `${planets.length} planets sit together in ${sign}${houseMean ? ` (the life-domain of ${houseMean})` : ''}: ${planets.join(', ')}. This is a foundation signature — these forces don't run on different currents, they share one ground.`,
      });
    }
  }

  // 3. Dignity balance
  let strong = 0, weak = 0;
  for (const [p, d] of Object.entries(chart)) {
    if (p.startsWith('__')) continue;
    if (d && d.dignity) {
      if (d.dignity.includes('exalted') || d.dignity.includes('own sign')) strong++;
      if (d.dignity.includes('debilitated') || d.dignity.includes('afflicted')) weak++;
    }
  }
  if (strong + weak >= 2) {
    findings.push({
      type: 'dignity_balance',
      strong, weak,
      synthesis: strong > weak
        ? `${strong} planet(s) at full strength; ${weak} constrained. The foundation is solid even where there are flags.`
        : strong < weak
        ? `${strong} at full strength; ${weak} constrained. A chart asking for honest reckoning with what is constrained, not just celebration of what is strong.`
        : `${strong} at full strength, ${weak} constrained. A chart in tension — equal strength and constraint, requiring careful synthesis.`,
    });
  }

  // 4. Lagna lord house-type
  if (houses && houses.lordPlacements && houses.lordPlacements[0]) {
    const ll = houses.lordPlacements[0];
    if (ll.lordIn) {
      const benefic = [1,4,5,7,9,10,11].includes(ll.lordIn);
      const malefic = [6,8,12].includes(ll.lordIn);
      if (benefic) {
        findings.push({
          type: 'lagna_lord_benefic_house',
          lordIn: ll.lordIn, lordInMeaning: ll.lordInMeaning,
          synthesis: `The planet running who you are has gone to a constructive life-domain (${ll.lordInMeaning}). What you build there is foundational, not incidental.`,
        });
      } else if (malefic) {
        findings.push({
          type: 'lagna_lord_malefic_house',
          lordIn: ll.lordIn, lordInMeaning: ll.lordInMeaning,
          synthesis: `The planet running who you are has gone to a difficult life-domain (${ll.lordInMeaning}). Identity here is forged through challenge, not given easily.`,
        });
      }
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Day-of-week ruler — Thai planetary mapping with Wed/Rahu split
// ─────────────────────────────────────────────────────────────────────────────
//
// Wednesday day → Mercury; Wednesday night (≥18:00 local) → Rahu. The split
// requires birth time. If no birth time, returns Mercury for Wednesday and
// the raw mapping for other days. Wed-night Rahu logic happens in chat.js
// where birthTime parsing already lives — kept here as a pure mapping.
const DAY_RULERS = ['Sun','Moon','Mars','Mercury','Jupiter','Venus','Saturn'];

function getDayOfWeekRuler(jplDate) {
  try {
    const [y, m, d] = jplDate.split('-').map(Number);
    return DAY_RULERS[new Date(Date.UTC(y, m-1, d)).getUTCDay()];
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level chart builder — one call returns everything
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the consolidated entry point. Both endpoints call this — chart.js
// hands the result back to the frontend; chat.js stringifies it for the
// system prompt cache. The chart object shape is:
//
// {
//   chart:        { Sun: {sign, degree, dignity, meaning, source}, ... },
//   rahuKetu:     { Rahu: {sign, degree, meaning, source}, Ketu: {...} },
//   ascendant:    { sign, degree, method } | null,
//   houses:       { houseOfPlanet, lordOfHouse, signInHouse, lordPlacements } | null,
//   convergences: [...],
//   coords:       { lat, lng, country? } | null,
//   jplDate:      'YYYY-MM-DD',
//   dayOfWeekRuler: 'Sun'|'Moon'|...,
//   sunSignMismatch: { differs, thaiSign, westernSign, isCusp, sentence } | null,
//   failedPlanets: ['Sun', ...]   // empty when full chart succeeded
//   geocodeImprecise: bool        // true if coords are country centroid
//   geocodeMethod:    'city_cache' | 'nominatim' | 'country_centroid' | 'failed'
// }
//
// Per-planet `source` field tags which engine produced the position:
//   "jpl"          — JPL Horizons + Lahiri (default today for the seven)
//   "suriyayatra"  — Thai canonical computation (when mandocca lands)
//   "computed"     — derived from formula, no fetch (Rahu/Ketu)
//
// v0.7 fields will be added to this object (nakshatra, tanuSesa, dasha,
// ninFlagDignity) without breaking the v0.6 shape — additive only.
async function buildChart({ birthday, birthplace, birthtime }) {
  if (!birthday) throw new Error('birthday required');

  // Normalize MM/DD/YYYY or MM-DD-YYYY → YYYY-MM-DD
  const parts = birthday.replace(/-/g, '/').split('/');
  const mo = parseInt(parts[0]);
  const dy = parseInt(parts[1]);
  const yr = parseInt(parts[2]);
  if (isNaN(mo) || isNaN(dy) || isNaN(yr)) throw new Error('invalid birthday');
  const jplDate = `${yr}-${String(mo).padStart(2,'0')}-${String(dy).padStart(2,'0')}`;

  // Parallel: chart fetch + geocoding (both are network-bound)
  const [chart, coords] = await Promise.all([
    getBirthChart(jplDate),
    geocode(birthplace || ''),
  ]);
  const rahuKetu = getRahuKetu(jplDate);

  // Ascendant requires birth time + coordinates
  const ascendant = computeAscendant(jplDate, birthtime, coords, chart.Sun);

  // House structure requires lagna
  const houses = ascendant ? computeHouseStructure(chart, rahuKetu, ascendant.sign) : null;

  // Day-of-week ruler (raw mapping; Wed/Rahu split happens in caller with birthtime)
  const dayOfWeekRuler = getDayOfWeekRuler(jplDate);

  // Convergences synthesize across all the above
  const convergences = detectConvergences(chart, rahuKetu, houses, dayOfWeekRuler);

  // Pull non-enumerable metadata into top-level fields for serialization
  const sunSignMismatch = chart.__sunSignMismatch || null;
  const failedPlanets = chart.__failedPlanets || [];

  // Surface geocoding quality so reading layer knows whether to trust the
  // lagna. When geocode used country centroid (imprecise:true), the rising
  // sign is unreliable — a country centroid is up to 2000 miles off in
  // continental countries. The reading should elide rising-sign references
  // in that case rather than confidently reporting a wrong lagna.
  const geocodeImprecise = !!(coords && coords.imprecise);
  const geocodeMethod = (coords && coords.geocodeMethod) || (coords ? 'unknown' : 'failed');

  return {
    chart,
    rahuKetu,
    ascendant,
    houses,
    convergences,
    coords,
    jplDate,
    dayOfWeekRuler,
    sunSignMismatch,
    failedPlanets,
    geocodeImprecise,
    geocodeMethod,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
//
// Top-level: buildChart() — both endpoints should use this.
// Granular exports kept for chat.js's cache-rebuild path and for tests.

export {
  // Top-level
  buildChart,
  // Constants (used by chat.js for prompt-time logic)
  ZODIAC_SIGNS,
  SIGN_LORD,
  PLANET_DIGNITY,
  SIGN_PLANET_MEANING,
  HOUSE_MEANING,
  // Granular functions
  getLahiriAyanamsa,
  lonToSign,
  getDignity,
  getWesternTropicalSunSign,
  detectSunSignMismatch,
  getBirthChart,
  getRahuKetu,
  geocode,
  computeAscendant,
  buildHouseMap,
  computeHouseStructure,
  detectConvergences,
  getDayOfWeekRuler,
};
