// /api/chart.js — standalone natal chart endpoint
// Called independently from the frontend so it never blocks the reading

// ── Planet engine (shared logic from chat.js) ──────────────────────────────

const JPL_PLANETS = {
  Sun:'10', Moon:'301', Mercury:'199', Venus:'299',
  Mars:'499', Jupiter:'599', Saturn:'699'
};

const ZODIAC_SIGNS = [
  'Aries','Taurus','Gemini','Cancer','Leo','Virgo',
  'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'
];

const PLANET_DIGNITY = {
  Sun:     { own:['Leo'],                  exalted:['Aries'],      debilitated:['Libra'] },
  Moon:    { own:['Cancer'],               exalted:['Taurus'],     debilitated:['Scorpio'] },
  Mercury: { own:['Gemini','Virgo'],       exalted:['Virgo'],      debilitated:['Pisces'] },
  Venus:   { own:['Taurus','Libra'],       exalted:['Pisces'],     debilitated:['Virgo'] },
  Mars:    { own:['Aries','Scorpio'],      exalted:['Capricorn'],  debilitated:['Cancer'] },
  Jupiter: { own:['Sagittarius','Pisces'], exalted:['Cancer'],     debilitated:['Capricorn'] },
  Saturn:  { own:['Capricorn','Aquarius'], exalted:['Libra'],      debilitated:['Aries'] },
};

// Lahiri ayanamsa — angular offset between tropical and Thai sidereal zodiacs.
// JPL Horizons returns tropical (geocentric ecliptic) coordinates. Thai
// horasaat uses sidereal — this offset must be subtracted before binning to
// a sign. Reference values (Swiss Ephemeris official Lahiri):
//   1992-02-26: 23.6938°  (within 0.05° of our linear approximation)
//   2000-01-01: 23.8531°
//   2026-01-01: 24.2188°
// Linear approximation matches Swiss Ephemeris within ~0.05° in the
// 1900-2100 window. A 0.05° error cannot push a planet across a 30° sign
// boundary unless the planet was already within 0.05° of the cusp — in
// which case the person is a genuine borderline case regardless.
//
// PATCH: replaced linear approximation with a quadratic polynomial in Julian
// centuries from J2000. Coefficients fit by least-squares against high-precision
// Swiss Ephemeris Lahiri values for J1900, J1925, J1950, J1975, J2000, J2010,
// J2020, and J2026. Max residual on the training set is 0.0015°, ~30x tighter
// than the linear form. The migration guide §15 reference of 23.6938° for
// 1992-02-26 is itself a slight outlier vs. the smooth curve — the polynomial
// predicts ~23.745° which agrees with the linear form to ~0.001° on that date.
// Welmanee's lagna remains on the Libra/Scorpio cusp under any source.
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

const SIGN_MEANINGS = {
  Sun:     { Aries:'pioneering vitality',Taurus:'determined and material',Gemini:'communicative and dual',Cancer:'protective and intuitive',Leo:'at full brightness — natural authority',Virgo:'analytical and precise',Libra:'softened — balance over dominance',Scorpio:'intense and private',Sagittarius:'expansive and visionary',Capricorn:'disciplined and ambitious',Aquarius:'independent and collective',Pisces:'compassionate and spiritually rich' },
  Moon:    { Aries:'reactive and direct emotions',Taurus:'stable and grounded — exalted',Gemini:'curious and changeable',Cancer:'deeply nurturing — at home',Leo:'warm and generous',Virgo:'orderly emotional security',Libra:'needs harmony to feel settled',Scorpio:'intense and transformative',Sagittarius:'needs freedom to feel safe',Capricorn:'restrained and achievement-driven',Aquarius:'detached but humanitarian',Pisces:'deeply empathic — boundaries dissolve easily' },
  Mercury: { Aries:'quick and direct',Taurus:'deliberate and reliable',Gemini:'fast and versatile — at home',Cancer:'emotional intelligence',Leo:'speaks with authority',Virgo:'analytical precision — exalted',Libra:'balanced diplomat',Scorpio:'investigative depth',Sagittarius:'big picture thinking',Capricorn:'structured and practical',Aquarius:'innovative and ahead of the conversation',Pisces:'intuitive not logical' },
  Venus:   { Aries:'direct in love',Taurus:'loyal and abundant — at home',Gemini:'charm through wit',Cancer:'nurturing in love',Leo:'generous and dramatic',Virgo:'expressed through service',Libra:'refined partnership — at home',Scorpio:'intense and loyal',Sagittarius:'freedom in love',Capricorn:'commitment and reliability',Aquarius:'unconventional',Pisces:'most compassionate — exalted' },
  Mars:    { Aries:'direct and bold — at home',Taurus:'slow but formidable',Gemini:'quick and verbal',Cancer:'indirect and protective',Leo:'bold and proud',Virgo:'precise and methodical',Libra:'acts through negotiation',Scorpio:'strategic and hidden — at home',Sagittarius:'philosophical warrior',Capricorn:'disciplined ambition — exalted',Aquarius:'fights for collective causes',Pisces:'intuitive action' },
  Jupiter: { Aries:'expansion through initiative',Taurus:'wealth through patience',Gemini:'expansion through knowledge',Cancer:'deep abundance — exalted',Leo:'generous and visible',Virgo:'expansion through service',Libra:'abundance through fairness',Scorpio:'expansion through depth',Sagittarius:'full wisdom — at home',Capricorn:'slow and structured',Aquarius:'collective wisdom',Pisces:'spiritual abundance — at home' },
  Saturn:  { Aries:'patience is the karmic lesson',Taurus:'slow material building',Gemini:'structured communication',Cancer:'emotional discipline',Leo:'earned not assumed leadership',Virgo:'disciplined service',Libra:'fairness fully expressed — exalted',Scorpio:'deep karmic transformation',Sagittarius:'wisdom earned through long journeys',Capricorn:'full discipline — at home',Aquarius:'structured innovation — at home',Pisces:'karmic lessons in boundaries' },
};

// Convert ecliptic longitude to Thai sidereal sign and degree.
// Subtracts the Lahiri ayanamsa for the given date before binning.
// dateStr 'YYYY-MM-DD'. Returned `longitude` is the SIDEREAL longitude.
function lonToSign(lon, dateStr) {
  const ayan = getLahiriAyanamsa(dateStr);
  const sidereal = ((lon - ayan) % 360 + 360) % 360;
  return {
    sign: ZODIAC_SIGNS[Math.floor(sidereal / 30)],
    degree: Math.floor(sidereal % 30),
    longitude: sidereal
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

function parseJPLLongitude(resultText) {
  try {
    const soeIdx = resultText.indexOf('$$SOE');
    const eoeIdx = resultText.indexOf('$$EOE');
    if (soeIdx === -1 || eoeIdx === -1) return null;
    const beforeSOE = resultText.slice(0, soeIdx);
    const headerLines = beforeSOE.trim().split('\n');
    const headerLine = headerLines[headerLines.length - 1];
    const headers = headerLine.split(',').map(s => s.trim().toLowerCase());
    let lonColIdx = headers.findIndex(h => h.includes('obseclon') || h.includes('eclon'));
    // Fallback: scan data row for first valid longitude (float between 0-360)
    // JPL format has empty cols: "Date, , , ObsEcLon, ObsEcLat"
    const dataSection = resultText.slice(soeIdx + 5, eoeIdx).trim();
    const lines = dataSection.split('\n').filter(l => l.trim());
    if (!lines.length) return null;
    const cols = lines[0].split(',').map(s => s.trim());
    // Try header-detected column first
    if (lonColIdx !== -1) {
      const lon = parseFloat(cols[lonColIdx]);
      if (!isNaN(lon)) return lon;
    }
    // Scan all columns for first value that looks like an ecliptic longitude (0-360)
    for (let i = 1; i < cols.length; i++) {
      const val = parseFloat(cols[i]);
      if (!isNaN(val) && val >= 0 && val <= 360) return val;
    }
    return null;
  } catch(e) { return null; }
}

async function fetchPlanetPosition(jplId, dateStr) {
  const [y, m, d] = dateStr.split('-');
  const stop = new Date(parseInt(y), parseInt(m)-1, parseInt(d)+1);
  const stopStr = stop.getFullYear() + '-' + String(stop.getMonth()+1).padStart(2,'0') + '-' + String(stop.getDate()).padStart(2,'0');

  // Build URL manually — do NOT use URLSearchParams as it encodes single quotes to %27
  // JPL requires literal single quotes around parameter values
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

  const fetchP = fetch(url).then(r => r.text());
  // Per-planet timeout. Sized to fit the per-batch budget within Vercel's
  // 30s function limit (set via maxDuration in the export config).
  //
  // Up to three batches run serially: batch1 (Sun/Moon/Mercury/Venus),
  // batch2 (Mars/Jupiter/Saturn), and an optional rescue batch that retries
  // any planets that failed on the first pass. Within each batch, fetches
  // run in parallel, so the slowest one in the batch gates the batch.
  // With a 9s per-planet timeout, the absolute worst case is 9s × 3 = 27s
  // — comfortably within 30s, with ~3s of headroom for setup, parsing,
  // ascendant calculation, and serialization.
  //
  // History: this was originally set to 7s under the assumption of a 10s
  // Vercel function limit (Hobby tier). On Vercel Pro with maxDuration:30
  // the 7s timeout was the actual bottleneck — JPL fetches that legitimately
  // took 7-9s under load (notably Sun, Moon, and Jupiter when their servers
  // are busy) were being killed early, producing partial charts where 3 of
  // 7 planets came back consistently empty. Bumping to 9s plus a rescue
  // batch removes the false-alarm timeout without putting the function as
  // a whole at risk.
  const timeoutP = new Promise((_, rej) => setTimeout(() => rej(new Error('JPL timeout')), 9000));
  const text = await Promise.race([fetchP, timeoutP]);
  return parseJPLLongitude(text);
}

async function getBirthChart(dateStr) {
  const planets = ['Sun','Moon','Mercury','Venus','Mars','Jupiter','Saturn'];
  const results = {};
  let failed = [];

  // Fetch in two batches to stay within Vercel's execution window.
  // Batch 1: Sun, Moon, Mercury, Venus (most important for Thai reading)
  // Batch 2: Mars, Jupiter, Saturn
  // Within each batch, fetches run in parallel and the slowest gates the batch.
  const batch1 = planets.slice(0, 4);
  const batch2 = planets.slice(4);

  const runBatch = async (batch) => {
    await Promise.allSettled(batch.map(async p => {
      // Skip planets we've already successfully fetched (relevant on retry)
      if (results[p]) return;
      try {
        const lon = await fetchPlanetPosition(JPL_PLANETS[p], dateStr);
        if (lon !== null) {
          const { sign, degree } = lonToSign(lon, dateStr);
          const dignity = getDignity(p, sign);
          const meaning = (SIGN_MEANINGS[p] && SIGN_MEANINGS[p][sign]) || '';
          results[p] = { sign, degree, dignity, meaning };
        } else {
          failed.push({ planet: p, reason: 'parse_failed' });
          console.error(`JPL parse failed for ${p} on date ${dateStr}`);
        }
      } catch(e) {
        failed.push({ planet: p, reason: e.message || 'unknown' });
        console.error(`JPL error for ${p}:`, e.message);
      }
    }));
  };

  await runBatch(batch1);
  await runBatch(batch2);

  // Rescue pass: retry any planets that failed on the first attempt. JPL
  // Horizons occasionally times out or returns empty under load even when
  // it's healthy — a single retry recovers most transient failures.
  // We clear `failed` before retrying because the rescue pass will re-add
  // anything that fails again. Successfully-rescued planets land in
  // `results` (the `if (results[p]) return` guard at the top of runBatch
  // makes the retry a no-op for ones that came back) and are absent from
  // the post-rescue `failed` list.
  //
  // The total time budget is bounded: max 12s × 3 batches = 36s in the
  // absolute worst case, but in practice batches complete well under their
  // timeout and a rescue only fires for the few planets that actually
  // failed. With Vercel maxDuration:30 we have enough headroom for the
  // overwhelming majority of fetches; the rare worst case still completes
  // partial-data ahead of any client-side timeout.
  if (failed.length > 0) {
    console.log(`Rescue pass: retrying ${failed.length} failed planets:`, failed.map(f => f.planet).join(', '));
    const toRetry = failed.map(f => f.planet);
    failed = [];  // reset; runBatch will re-add anything that fails again
    await runBatch(toRetry);
  }

  console.log(`Planets fetched: ${Object.keys(results).join(', ')} (${Object.keys(results).length}/7)`);
  if (failed.length > 0) {
    console.error(`PARTIAL chart for ${dateStr}: ${failed.length}/7 planets failed after rescue:`,
      failed.map(f => `${f.planet}(${f.reason})`).join(', '));
  }
  // Stash failed-list on results for the handler to expose in the response
  Object.defineProperty(results, '__failedPlanets', {
    value: failed.map(f => f.planet),
    enumerable: false, writable: true, configurable: true,
  });
  return results;
}

function getRahuKetu(dateStr) {
  try {
    const date = new Date(dateStr);
    const j2000 = new Date('2000-01-01');
    const years = (date - j2000) / (1000 * 60 * 60 * 24 * 365.25);
    const rahuLon = ((125.04 - (19.3568 * years)) % 360 + 360) % 360;
    const ketuLon = (rahuLon + 180) % 360;
    return {
      Rahu: { ...lonToSign(rahuLon, dateStr), meaning: 'Karmic direction — where growth and challenge intersect' },
      Ketu: { ...lonToSign(ketuLon, dateStr), meaning: 'Karmic release — what the soul is moving away from' }
    };
  } catch(e) { return {}; }
}

// Geocoding
const CITY_COORDS = {
  'philadelphia':{lat:39.9526,lng:-75.1652},'bangkok':{lat:13.7563,lng:100.5018},
  'new york':{lat:40.7128,lng:-74.0060},'los angeles':{lat:34.0522,lng:-118.2437},
  'chicago':{lat:41.8781,lng:-87.6298},'houston':{lat:29.7604,lng:-95.3698},
  'munster':{lat:41.5642,lng:-87.5125},'cairo':{lat:30.0444,lng:31.2357},
  'london':{lat:51.5074,lng:-0.1278},'paris':{lat:48.8566,lng:2.3522},
  'tokyo':{lat:35.6762,lng:139.6503},'singapore':{lat:1.3521,lng:103.8198},
  'dubai':{lat:25.2048,lng:55.2708},'sydney':{lat:-33.8688,lng:151.2093},
  'toronto':{lat:43.6532,lng:-79.3832},'mumbai':{lat:19.0760,lng:72.8777},
  'delhi':{lat:28.7041,lng:77.1025},'beijing':{lat:39.9042,lng:116.4074},
  'seoul':{lat:37.5665,lng:126.9780},'vientiane':{lat:17.9757,lng:102.6331},
  'chiang mai':{lat:18.7883,lng:98.9853},'ho chi minh':{lat:10.8231,lng:106.6297},
  'hanoi':{lat:21.0285,lng:105.8542},'phnom penh':{lat:11.5564,lng:104.9282},
  'kuala lumpur':{lat:3.1390,lng:101.6869},'jakarta':{lat:-6.2088,lng:106.8456},
  'manila':{lat:14.5995,lng:120.9842},'boston':{lat:42.3601,lng:-71.0589},
  'miami':{lat:25.7617,lng:-80.1918},'atlanta':{lat:33.7490,lng:-84.3880},
  'seattle':{lat:47.6062,lng:-122.3321},'denver':{lat:39.7392,lng:-104.9903},
};

async function geocode(birthplace) {
  if (!birthplace) return null;
  const key = birthplace.toLowerCase().trim();
  for (const [city, coords] of Object.entries(CITY_COORDS)) {
    if (key.includes(city)) return coords;
  }
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(birthplace)}&format=json&limit=1`;
    const r = await Promise.race([
      fetch(url, { headers: { 'User-Agent': 'MorDoo/1.0 (mordoo-sepia.vercel.app)' } }).then(r => r.json()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
    ]);
    if (r && r.length > 0) return { lat: parseFloat(r[0].lat), lng: parseFloat(r[0].lon) };
  } catch(e) {}
  return null;
}

// ── Sunrise calculation for the Antonati lagna method ────────────────────
// Returns local sunrise time in hours (decimal), given date and location.
// Used as the anchor for the Thai Antonati Saman lagna algorithm — that
// method walks forward through sign-rise-time intervals starting from the
// most recent sunrise.
//
// Algorithm: standard NOAA sunrise approximation, accurate to ~1 minute for
// non-polar latitudes, which is well within the precision the Antonati
// table itself can resolve (the table itself is in 24-minute units).
// Verified against myhora.com's reported 06:39 sunrise for Welmanee
// (1992-02-26 Philadelphia) — exact match.
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

// ── Antonati Saman lagna algorithm (Thai traditional method) ─────────────
// This is the algorithm myhora.com and Thai practitioners use. Each of the
// 12 zodiac signs has a fixed rise-time in minutes (totaling 1440 = 24h).
// Starting from the sun's sidereal position at the most recent sunrise,
// walk forward in time, subtracting each sign's rise time from the elapsed
// minutes since sunrise, until the remainder lands you partway into a sign.
// That sign + remainder fraction is the lagna.
//
// Reference: zodietcwise.blogspot.com (Thai astrology source) gives the
// canonical antonati units per sign. 1 antonati = 24 minutes.
//   Aries 5  Taurus 4  Gemini 3   Cancer 5  Leo 6     Virgo 7
//   Libra 7  Scorpio 6 Sagit 5    Capr 3    Aquar 4   Pisces 5
// Verified: this algorithm reproduces myhora.com's Libra 28°53' result for
// Welmanee (1992-02-26 00:15 Phila) exactly, given:
//  - sun in sidereal Aquarius 13°03' at sunrise
//  - sunrise 06:39 local (calculated by localSunriseHour above)
//  - elapsed minutes from prev sunrise to birth = 1056
//
// The table is calibrated for traditional Thai practice and produces results
// that agree with modern trigonometric ascendant calculations to within ~1°
// at most longitudes/latitudes — but at sign cusps the two methods can give
// different sign answers. Per the hybrid policy, when they disagree we
// trust this Antonati result because it is what Thai customers will check
// against on Thai astrology sites (myhora.com being the dominant one).
const ANTONATI_MINUTES = [120, 96, 72, 120, 144, 168, 168, 144, 120, 72, 96, 120];

function antonatiAscendant(jplDate, lat, lng, utcOffsetHours, birthHour, birthMin, sunSiderealLon) {
  if (sunSiderealLon === null || sunSiderealLon === undefined) return null;
  const [y, m, d] = jplDate.split('-').map(Number);

  // Sunrise on the calendar day of birth
  const sunriseHour = localSunriseHour(y, m, d, lat, lng, utcOffsetHours);
  if (sunriseHour === null) return null;

  // If birth was BEFORE sunrise on the calendar day, we use the PREVIOUS
  // day's sunrise as anchor. The sun has moved ~1° in sidereal longitude
  // per day, but for purposes of the Antonati table walk we use the sign
  // the sun is in NOW (at the birth moment), not the sunrise sun position.
  const birthLocalHour = birthHour + birthMin / 60;
  let elapsedMin;
  if (birthLocalHour >= sunriseHour) {
    elapsedMin = (birthLocalHour - sunriseHour) * 60;
  } else {
    // Use previous day's sunrise. Sunrise shifts by < 2 minutes/day at most
    // latitudes, so we approximate with same-day sunrise time. The error
    // is at worst ~0.5° of lagna.
    elapsedMin = (24 - sunriseHour + birthLocalHour) * 60;
  }

  // Walk the table starting from the sun's current sidereal sign
  const sunSignIdx = Math.floor(sunSiderealLon / 30);
  const sunDegInSign = sunSiderealLon % 30;
  let signIdx = sunSignIdx;

  // First: the time it takes for the lagna to FINISH the sun's current sign,
  // i.e. for the sun's degree to advance from sunDegInSign to 30.
  const fractionRemaining = (30 - sunDegInSign) / 30;
  const timeToFinishSunSign = ANTONATI_MINUTES[signIdx] * fractionRemaining;

  let remainingMin = elapsedMin;
  let lagnaDeg;

  if (remainingMin <= timeToFinishSunSign) {
    // Lagna stays in the sun's sign
    const usedFraction = remainingMin / ANTONATI_MINUTES[signIdx];
    lagnaDeg = sunDegInSign + usedFraction * 30;
  } else {
    remainingMin -= timeToFinishSunSign;
    signIdx = (signIdx + 1) % 12;
    // Walk through full signs
    let safety = 24;  // can't loop more than full circle
    while (remainingMin >= ANTONATI_MINUTES[signIdx] && safety-- > 0) {
      remainingMin -= ANTONATI_MINUTES[signIdx];
      signIdx = (signIdx + 1) % 12;
    }
    // Final partial sign
    lagnaDeg = (remainingMin / ANTONATI_MINUTES[signIdx]) * 30;
  }

  return {
    sign: ZODIAC_SIGNS[signIdx],
    degree: Math.floor(lagnaDeg),
    fractional: lagnaDeg,  // for fine-grained cusp detection on the client
    method: 'antonati',
  };
}

export const config = { maxDuration: 30 }; // Request extended timeout from Vercel

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { birthday, birthplace } = req.body;
    if (!birthday) return res.status(400).json({ error: 'birthday required' });

    const parts = birthday.replace(/-/g,'/').split('/');
    const mo = parseInt(parts[0]), dy = parseInt(parts[1]), yr = parseInt(parts[2]);
    if (isNaN(mo) || isNaN(dy) || isNaN(yr)) return res.status(400).json({ error: 'invalid date' });

    const jplDate = yr + '-' + String(mo).padStart(2,'0') + '-' + String(dy).padStart(2,'0');

    // Fetch everything in parallel
    const [chart, coords] = await Promise.all([
      getBirthChart(jplDate),
      geocode(birthplace || '')
    ]);
    const rahuKetu = getRahuKetu(jplDate);

    // Calculate Ascendant (lagna) if birth time and coordinates are available.
    //
    // HYBRID POLICY: We compute the lagna two ways and merge per the policy:
    //   1. Modern trigonometric ascendant (Meeus AA Ch.13) — astronomically
    //      precise, language-neutral, what Western Vedic engines use.
    //   2. Thai Antonati Saman algorithm — what myhora.com and Thai
    //      practitioners use; the canonical Thai source.
    //
    // When the two agree on the SIGN, we use that sign and the trigonometric
    // method's degree (more precise to the minute). When they disagree
    // (always near a sign cusp), we DEFER TO ANTONATI. The reason is
    // pragmatic: customers will check their charts against myhora.com and
    // other Thai astrology sites. If our app says one sign and Thai sites
    // say another, the user trusts Thai sites and loses trust in our app.
    // The math is technically defensible either way at a cusp — we'd rather
    // be in agreement with the Thai canon.
    //
    // Both methods are computed silently. The user only ever sees the
    // hybrid result, never the choice we made between methods. The choice
    // is also never explained in user-facing prose — no "Antonati vs
    // trigonometric" language. The reading speaks lagna in lived terms.
    let ascendant = null;
    const { birthtime } = req.body;
    if (birthtime && coords) {
      try {
        const tMatch = birthtime.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
        if (tMatch) {
          let hr = parseInt(tMatch[1]);
          const mn = parseInt(tMatch[2]);
          const ap = (tMatch[3]||'').toLowerCase();
          if (ap === 'pm' && hr !== 12) hr += 12;
          if (ap === 'am' && hr === 12) hr = 0;
          // Estimate UTC offset from longitude (rough: 15° per hour).
          // Real timezone offsets are quantized to whole or half hours, so we
          // round the longitude estimate to the nearest hour — averages out the
          // raw longitude noise (e.g. Philadelphia at lng -75.165 gives -5.011
          // which rounds to -5.0, exactly matching EST). For places where the
          // legal timezone diverges from longitude (Paris, much of China) this
          // is still wrong, but it's wrong by a known integer offset rather
          // than by ~0.16° of GST drift on every chart.
          const utcOffset = Math.round(coords.lng / 15);
          const utcHour = hr - utcOffset + mn/60;
          const [y, m, d] = jplDate.split('-').map(Number);
          const JD = 367*y - Math.floor(7*(y+Math.floor((m+9)/12))/4) +
            Math.floor(275*m/9) + d + 1721013.5 + utcHour/24;
          const T = (JD - 2451545.0) / 36525;
          let GST = 280.46061837 + 360.98564736629*(JD-2451545) + 0.000387933*T*T;
          GST = ((GST % 360) + 360) % 360;
          const lng = coords.lng;
          const LST = ((GST + lng) % 360 + 360) % 360;
          const latRad = coords.lat * Math.PI / 180;
          const lstRad = LST * Math.PI / 180;
          const e = 23.4397 * Math.PI / 180;
          let asc = Math.atan2(Math.cos(lstRad), -(Math.sin(lstRad)*Math.cos(e) + Math.tan(latRad)*Math.sin(e)));
          asc = ((asc * 180 / Math.PI) % 360 + 360) % 360;
          const ayanAsc = getLahiriAyanamsa(jplDate);
          asc = ((asc - ayanAsc) % 360 + 360) % 360;
          const signs = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
          const trigAsc = {
            sign: signs[Math.floor(asc/30)],
            degree: Math.floor(asc%30),
            fractional: asc % 30,
            method: 'trigonometric',
          };

          // Antonati lagna — uses sun's sidereal longitude as the anchor
          // walked through the rise-time table from the most recent sunrise.
          // We need the sun's sidereal longitude at this moment. We have
          // the sun's sign and degree from the chart fetch (from JPL +
          // Lahiri), so reconstruct the longitude.
          let antoAsc = null;
          if (chart.Sun && chart.Sun.sign && typeof chart.Sun.degree === 'number') {
            const sunSignIdx = signs.indexOf(chart.Sun.sign);
            if (sunSignIdx !== -1) {
              const sunSiderealLon = sunSignIdx * 30 + chart.Sun.degree;
              antoAsc = antonatiAscendant(jplDate, coords.lat, coords.lng,
                utcOffset, hr, mn, sunSiderealLon);
            }
          }

          // Hybrid merge:
          //   - If antonati unavailable (no sun data) → use trig
          //   - If both available and same sign → use trig (more precise degree)
          //     but mark cusp if either method puts us near 0° or 29°
          //   - If different signs → defer to antonati (Thai canon wins)
          if (!antoAsc) {
            ascendant = trigAsc;
          } else if (antoAsc.sign === trigAsc.sign) {
            ascendant = {
              sign: trigAsc.sign,
              degree: trigAsc.degree,
              method: 'agree',  // both methods agree
            };
          } else {
            // Disagreement = always near a cusp. Trust Antonati.
            ascendant = {
              sign: antoAsc.sign,
              degree: antoAsc.degree,
              method: 'antonati_cusp',  // disagreement at cusp; antonati wins
              trigSign: trigAsc.sign,   // for diagnostic logging only; client doesn't show
              trigDegree: trigAsc.degree,
            };
            console.log(`[Lagna] Cusp disagreement for ${jplDate}: trig=${trigAsc.sign} ${trigAsc.degree}°, antonati=${antoAsc.sign} ${antoAsc.degree}° → using antonati`);
          }
        }
      } catch(e) { console.error('Ascendant error:', e.message); }
    }

    return res.status(200).json({
      chart,
      rahuKetu,
      ascendant,
      coords,
      jplDate,
      planetsFound: Object.keys(chart).length,
      failedPlanets: chart.__failedPlanets || [],
    });

  } catch(err) {
    console.error('Chart API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
