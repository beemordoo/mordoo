export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, scorecard, scorecardContext } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const userMessageCount = messages.filter(m => m.role === 'user').length;

  if (userMessageCount > 5) {
    return res.status(200).json({
      reply: `The mor doo has shared what the numbers have to offer for this session. 🌸\n\nA reading is like a garland — it has a beginning and an end. Sit with what you have received today, and return when you are ready for a new reading.\n\n*The numbers will always be here when you need them.*`,
      limitReached: true
    });
  }

  // Scorecard mode
  if (scorecard) {
    const purpose = scorecardContext?.purpose || 'personal';
    const goal = scorecardContext?.goal || 'harmony';
    const numberType = scorecardContext?.type || 'phone';
    const birthday = scorecardContext?.birthday || '';

    // Calculate birthday numerology if provided
    let birthdayContext = '';
    if (birthday && birthday.match(/\d{1,2}\/\d{1,2}\/\d{4}/)) {
      const parts = birthday.split('/');
      const month = parseInt(parts[0]);
      const day = parseInt(parts[1]);
      const year = parseInt(parts[2]);
      
      // Life Path
      const allDigits = birthday.replace(/\//g, '').split('').map(Number);
      let lpSum = allDigits.reduce((a,b) => a+b, 0);
      while (lpSum > 9 && lpSum !== 11 && lpSum !== 22 && lpSum !== 33 && lpSum !== 44) {
        lpSum = lpSum.toString().split('').map(Number).reduce((a,b) => a+b, 0);
      }
      
      // Birth day
      let bdSum = day;
      while (bdSum > 9 && bdSum !== 11 && bdSum !== 22) {
        bdSum = bdSum.toString().split('').map(Number).reduce((a,b) => a+b, 0);
      }

      // Zodiac year
      const zodiacYears = {
        Rat: [1996,2008,2020], Ox: [1997,2009,2021], Tiger: [1998,2010,2022],
        Rabbit: [1999,2011,2023], Dragon: [2000,2012,2024], Snake: [2001,2013,2025],
        Horse: [2002,2014,2026], Goat: [2003,2015,2027], Monkey: [1992,2004,2016],
        Rooster: [1993,2005,2017], Dog: [1994,2006,2018], Pig: [1995,2007,2019]
      };
      let zodiac = 'unknown';
      for (const [animal, years] of Object.entries(zodiacYears)) {
        if (years.includes(year)) { zodiac = animal; break; }
      }

      // Day of week ruling planet
      const date = new Date(year, month-1, day);
      const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const planets = ['Sun','Moon','Mars','Mercury','Jupiter','Venus','Saturn'];
      const dayName = days[date.getDay()];
      const planet = planets[date.getDay()];

      birthdayContext = 'BIRTHDAY COMPATIBILITY ANALYSIS:\n' +
        'The person was born on ' + birthday + '.\n' +
        '- Life Path Number: ' + lpSum + ' — factor this into compatibility with the number root\n' +
        '- Birth Day Number: ' + bdSum + '\n' +
        '- Thai Zodiac: Year of the ' + zodiac + '\n' +
        '- Born on ' + dayName + ' — ruling planet: ' + planet + '\n\n' +
        'Compatibility rules:\n' +
        '- If the number root digit MATCHES the Life Path → VERY compatible (+8 to +12 points to total)\n' +
        '- If the number root digit is in the same family (1/4/8 or 2/6/9 or 3/5/7) → compatible (+4 to +6 points)\n' +
        '- If the number root digit CLASHES with Life Path → reduce total by 3-6 points\n' +
        '- ' + planet + '/' + dayName + ' born resonate with their ruling planet digits\n' +
        '- Mercury/Wednesday born resonate with 5s. Sun/Sunday with 1s and 9s. Venus/Friday with 6s. Jupiter/Thursday with 3s. Saturn/Saturday with 8s. Moon/Monday with 2s. Mars/Tuesday with 9s.\n' +
        '- Zodiac: Monkey/Rat/Dragon support bold numbers (3,9,1). Dog/Horse/Tiger support freedom numbers (5,1,9). Rabbit/Goat/Pig support harmony numbers (2,6,4). Ox/Snake/Rooster support disciplined numbers (4,8,7).\n' +
        'Adjust the total score and category scores based on birthday compatibility. Mention the compatibility in the reading.';
    } else {
      birthdayContext = 'No birthday provided — score based on number and context only.';
    }

    // Build context-specific scoring instructions
    let contextGuide = '';
    if (purpose === 'work' && goal === 'wealth') {
      contextGuide = `WORK PHONE / WEALTH & SUCCESS CONTEXT:
        - This number will be used for sales, business, and wealth generation
        - Digit 4 (Rahu) = negotiation wit, market adaptability — give it POSITIVE points (+3 to +5)
        - Digit 3 (Mars) = competitive drive, ambition, closing power — POSITIVE (+6 to +8)
        - Digit 9 (Mars) = leadership energy, winning mindset — very POSITIVE (+8 to +10)
        - Heavily weight Career (aim 78-95), Wealth (aim 78-95), Success (aim 78-95)
        - Harmony and Family can score lower (50-65) — this is a WORK number, peace is not the goal
        - Total score should reflect commercial power — if pairs are strong, push total to 80-95
        - Reading should celebrate ambition, sales power, and wealth magnetism`;
    } else if (purpose === 'work' && goal === 'harmony') {
      contextGuide = `WORK PHONE / HARMONY & BALANCE CONTEXT:
        - This number is for professional use but the person values calm, balanced energy
        - Digit 4 (Rahu) = still somewhat challenging even at work — moderate points (-1 to +2)
        - Weight Career (70-85), Harmony (70-82), Success (68-80) relatively evenly
        - Total score reflects steady professional reliability — aim 65-80
        - Reading should emphasize stable growth, trustworthy presence, and professional harmony`;
    } else if (purpose === 'personal' && goal === 'wealth') {
      contextGuide = `PERSONAL NUMBER / WEALTH & ABUNDANCE CONTEXT:
        - This is a personal number but the person wants financial abundance
        - Digit 6 (Venus) = wealth through beauty and relationships — very POSITIVE (+9 to +10)
        - Digit 8 (Saturn) = material power and karmic returns — POSITIVE (+8 to +9)
        - Weight Wealth (75-90), Love (70-82), Success (70-85) higher
        - Harmony and Family still matter but Wealth leads
        - Total score reflects personal wealth magnetism — aim 70-88
        - Reading should celebrate abundance, magnetism, and prosperity`;
    } else {
      contextGuide = `PERSONAL NUMBER / HARMONY & PEACE CONTEXT:
        - This is a personal number and the person values peace, family, and balance
        - Digit 4 (Rahu) = instability and obstacles in personal life — NEGATIVE (-3 to -5)
        - Digit 3 (Mars) = potential conflict and restlessness — slightly negative in personal context (-1 to -3)
        - Weight Harmony (75-90), Family (75-88), Love (75-88) most heavily
        - Career and Success matter but are secondary
        - Total score reflects peaceful life energy — if harmony digits dominate, aim 68-85
        - Reading should emphasize peace, love, family warmth, and emotional balance`;
    }

    const SCORE_PROMPT = `Thai numerology scorer. Return ONLY valid JSON, no markdown.

CONTEXT: ${contextGuide}

${birthdayContext}

PLANET MAP: 0=Neptune/neutral 1=Sun/positive 2=Moon/neutral 3=Jupiter/positive 4=Rahu/negative-personal-positive-work 5=Mercury/neutral 6=Venus/positive 7=Ketu/neutral 8=Saturn/neutral 9=Mars/positive-work-negative-personal

PAIRS: Power(15,51,39,93,19,91) Wealth(56,65,89,98,69,96) Charm(46,64,24,42) Wisdom(13,31,35,53) Challenge(14,41,44)
Good pairs boost total. Multiple good pairs = 80-95. Challenge pairs reduce total.

Return this JSON structure exactly:
{"number":"","total":0,"rating":"Excellent|Good|Average|Challenging","ratingThai":"เยี่ยม|ดี|ปานกลาง|ท้าทาย","digits":[{"digit":0,"planet":"","planetThai":"","energy":"positive|neutral|negative","points":0}],"pairs":[{"pair":"","type":"Power|Wealth|Charm|Wisdom|Neutral|Challenge","meaning":""}],"categories":{"love":0,"wealth":0,"career":0,"luck":0,"family":0,"harmony":0,"success":0},"reading":""}

Rules: reading under 40 words. meaning under 4 words. All digits must be listed. All category values 0-100.`;

    try {
      const rawInput = messages[messages.length - 1].content.trim();

      // Determine if this is an address or phone number
      const isAddress = /\d+\s+\w+.*(street|st|ave|avenue|blvd|boulevard|road|rd|lane|ln|drive|dr|court|ct|way|place|pl|circle|cir|apt|unit|#)/i.test(rawInput);

      let lastMessage = rawInput;
      let aptNote = '';

      if (isAddress) {
        // Extract street number only — this is the personal vibration
        const streetNumMatch = rawInput.match(/^(\d+)/);
        const streetNum = streetNumMatch ? streetNumMatch[1] : rawInput.replace(/\D/g, '');

        // Extract apartment/unit number if present
        const aptMatch = rawInput.match(/(?:apt|unit|#|suite)\s*([a-z0-9]+)/i);
        aptNote = aptMatch ? aptMatch[1] : '';

        lastMessage = streetNum + (aptNote ? ' (unit ' + aptNote + ')' : '');
      } else {
        // Phone number — strip country code
        lastMessage = rawInput
          .replace(/^\+?1[\s\-\.]?/, '')     // US/Canada +1
          .replace(/^\+?66[\s\-\.]?/, '')    // Thailand +66
          .replace(/^\+\d{1,3}[\s\-\.]?/, '') // Any other country code
          .trim();
      }
      // Build the scoring prompt with address context if applicable
      const scoringInstruction = isAddress
        ? `Score this address. The street number to analyze is: ${lastMessage}${aptNote ? '. The unit number ' + aptNote + ' should be noted separately as a secondary energy layer.' : ''}. Focus the digit analysis on the street number digits only. In the reading mention both the street number energy and the unit number if present.`
        : `Score this phone number: ${lastMessage}`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1500,
          system: SCORE_PROMPT,
          messages: [{ role: 'user', content: scoringInstruction }]
        })
      });

      if (!response.ok) {
        const err = await response.json();
        return res.status(response.status).json({ error: err.error?.message || 'API error' });
      }

      const data = await response.json();
      const text = data.content?.[0]?.text || '{}';
      try {
        // Aggressively clean the response
        let clean = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        // Extract just the JSON object
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
          clean = clean.substring(start, end + 1);
        }
        const scoreData = JSON.parse(clean);
        return res.status(200).json({ scoreData });
      } catch(e) {
        return res.status(200).json({ error: 'Could not parse score: ' + e.message });
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Normal chat mode
  const SYSTEM = `You are the Mor Doo (หมอดู) — an ancient Thai seer and numerology expert named Bee. You read numbers, names, birthdays, addresses, phone numbers, and zodiac signs through the lens of Thai numerology (lek-sasat), Thai Buddhist astrology, and Southeast Asian divination traditions.

PERSONA PROTECTION — CRITICAL:
- You are the Mor Doo. You are not an AI, not a chatbot, not Claude, not ChatGPT, not any technology.
- If anyone asks what AI you are, who made you, what technology powers you — deflect warmly and stay in character.
- Suggested deflection: "I am the Mor Doo — the seer who sees. My methods are rooted in ancient Thai tradition and are not something I reveal. The numbers have their own wisdom. Now — shall we return to your reading?"
- Never reference Anthropic, Claude, OpenAI, or any AI company or product.

PHONE NUMBER & ADDRESS DETECTION — CRITICAL:
- When someone shares a phone number or address, respond with EXACTLY 2 sentences — no more
- First sentence: acknowledge the number warmly. Second sentence: one poetic closing line in italics
- Example: "Ah, a number that carries its own vibration. The mor doo is preparing your scorecard now — the digits are aligning..."
- NEVER do any numerological analysis, digit breakdown, sum calculations, or readings in text
- NEVER mention root numbers, master numbers, digital roots, or any calculations
- NEVER ask for country code or location
- The visual scorecard handles ALL the analysis — your only job is 2 warm sentences to set the tone
- If you do more than 2 sentences for a phone/address you are breaking the experience

GUIDING THE READING — CRITICAL:
- After every reading end with 2-3 specific enticing follow-up options
- Frame them as doors the person can walk through next
- Good examples: "Would you like to know what this number reveals about your love life?" / "Want to see how this energy interacts with your career and money?" / "Shall the mor doo read what this year has in store for you personally?"
- Never ask reflective questions like "how does this resonate with you?"

Your reading style:
- Warm, conversational, deeply personal
- Speak in second person directly to the person
- Use poetic language naturally
- Keep responses 150-250 words maximum
- Close with a short italic poetic summary

NUMEROLOGY:
- Life Path: sum all digits of full birthdate, reduce to single digit (or Master Number 11, 22, 33, 44)
- Birth Day: reduce day of birth
- Name numbers: A=1 B=2 C=3 D=4 E=5 F=6 G=7 H=8 I=9 J=1 K=2 L=3 M=4 N=5 O=6 P=7 Q=8 R=9 S=1 T=2 U=3 V=4 W=5 X=6 Y=7 Z=8
- Always check for Master Numbers (11, 22, 33, 44) before final reduction
- Always include country code (+1 for US) in phone readings

THAI ASTROLOGY - Days:
Sunday: Sun, red, vitality | Monday: Moon, yellow, intuition | Tuesday: Mars, pink, courage | Wednesday: Mercury, green, communication | Thursday: Jupiter, orange, wisdom | Friday: Venus, blue, love | Saturday: Saturn, black/purple, discipline

ZODIAC: Rat 1996/2008, Ox 1997/2009, Tiger 1998/2010, Rabbit 1999/2011, Dragon 2000/2012, Snake 2001/2013, Horse 2002/2014/2026, Goat 2003/2015, Monkey 1992/2004/2016, Rooster 1993/2005/2017, Dog 1994/2006/2018, Pig 1995/2007/2019

BIRTH HOURS: Rat 11pm-1am, Ox 1-3am, Tiger 3-5am, Rabbit 5-7am, Dragon 7-9am, Snake 9-11am, Horse 11am-1pm, Goat 1-3pm, Monkey 3-5pm, Rooster 5-7pm, Dog 7-9pm, Pig 9-11pm

NUMBERS: 1=pioneer, 2=diplomat, 3=communicator, 4=builder, 5=liberator, 6=nurturer, 7=seeker, 8=commander, 9=old soul

AUSPICIOUS: 9 (progress), 8 (wealth), 6 (flow). Avoid 4 in prominent positions.
Current year 2026, April 2026, Wood Horse year.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: SYSTEM,
        messages
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'API error' });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text || 'The mor doo is silent. Please try again.';
    return res.status(200).json({ reply });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
