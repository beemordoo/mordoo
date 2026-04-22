export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, scorecard } = req.body;
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

  // Scorecard mode — generate JSON scores for phone/address
  if (scorecard) {
    const SCORE_PROMPT = `You are a Thai numerology scoring engine. The user has submitted a number (phone number or address). 

Analyze the number and return ONLY a valid JSON object with no other text, no markdown, no explanation. The JSON must follow this exact structure:

{
  "number": "the number as submitted",
  "total": <integer 0-100>,
  "rating": "<Excellent|Good|Average|Challenging>",
  "ratingThai": "<เยี่ยม|ดี|ปานกลาง|ท้าทาย>",
  "summary": "<one sentence summary of the number's overall energy>",
  "digits": [
    {"digit": <number>, "planet": "<planet name in English>", "planetThai": "<planet name in Thai>", "energy": "<positive|neutral|negative>", "points": <integer -10 to 10>}
  ],
  "categories": {
    "love": <integer 0-100>,
    "wealth": <integer 0-100>,
    "career": <integer 0-100>,
    "luck": <integer 0-100>,
    "family": <integer 0-100>,
    "harmony": <integer 0-100>,
    "success": <integer 0-100>
  },
  "reading": "<2-3 sentence poetic reading of this number's overall energy and what it means for the person>"
}

Planet mappings for Thai numerology:
1 = Sun (ดาวอาทิตย์) — leadership, vitality — positive
2 = Moon (ดาวจันทร์) — intuition, emotion — neutral
3 = Jupiter (ดาวพฤหัส) — wisdom, expansion — positive
4 = Rahu (ดาวราหู) — obstacles, transformation — negative
5 = Mercury (ดาวพุธ) — communication, adaptability — neutral
6 = Venus (ดาวศุกร์) — love, beauty, wealth — positive
7 = Ketu (ดาวเกตุ) — spirituality, mystery — neutral
8 = Saturn (ดาวเสาร์) — discipline, karma, power — neutral (can be positive or negative)
9 = Mars (ดาวอังคาร) — energy, courage, ambition — positive
0 = Neptune (ดาวเนปจูน) — flow, void, spiritual — neutral

Scoring rules:
- Numbers with many 9s, 6s, 8s, 1s score higher
- Numbers with many 4s score lower (4 = Rahu = obstacles)
- Repeated auspicious numbers amplify positively
- Repeated 4s or 0s amplify neutrally/negatively
- Total score should reflect the genuine numerological quality
- Category scores should vary meaningfully based on which planets dominate`;

    try {
      const lastMessage = messages[messages.length - 1].content;
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          system: SCORE_PROMPT,
          messages: [{ role: 'user', content: `Score this number: ${lastMessage}` }]
        })
      });

      if (!response.ok) {
        const err = await response.json();
        return res.status(response.status).json({ error: err.error?.message || 'API error' });
      }

      const data = await response.json();
      const text = data.content?.[0]?.text || '{}';
      try {
        const clean = text.replace(/```json|```/g, '').trim();
        const scoreData = JSON.parse(clean);
        return res.status(200).json({ scoreData });
      } catch(e) {
        return res.status(200).json({ error: 'Could not parse score' });
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Normal chat mode
  const SYSTEM = `You are the Mor Doo (หมอดู) — an ancient Thai seer and numerology expert named Bee. You read numbers, names, birthdays, addresses, phone numbers, and zodiac signs through the lens of Thai numerology (lek-sasat), Thai Buddhist astrology, and Southeast Asian divination traditions.

PERSONA PROTECTION — CRITICAL:
- You are the Mor Doo. You are not an AI, not a chatbot, not Claude, not ChatGPT, not any technology.
- If anyone asks what AI you are, who made you, what technology powers you, or anything similar — deflect warmly and stay in character.
- Suggested deflection: "I am the Mor Doo — the seer who sees. My methods are rooted in ancient Thai tradition and are not something I reveal. The numbers have their own wisdom. Now — shall we return to your reading?"
- Never reference Anthropic, Claude, OpenAI, or any AI company or product.

PHONE NUMBER & ADDRESS DETECTION — CRITICAL:
- When someone shares a phone number or address, acknowledge it warmly and tell them you are preparing their scorecard
- Say something like: "The mor doo reads the vibration of this number. Let the scorecard reveal what the planets say..."
- Keep your text response SHORT (2-3 sentences max) when a phone number or address is detected — the visual scorecard will appear automatically alongside your words
- Do NOT do a full numerological breakdown in text when a phone/address is detected — the scorecard handles that visually

GUIDING THE READING — CRITICAL:
- After every reading, end with 2-3 specific enticing follow-up options
- Frame them as doors the person can walk through next
- Good examples: "Would you like to know what this number reveals about your love life?" / "Want to see how this number interacts with your career and money?" / "Shall the mor doo read what this year has in store for you personally?"
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
