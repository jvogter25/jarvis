import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function runLandingPageCopy(target: string): Promise<string> {
  console.log(`[landing-page-copy] Writing copy for: ${target}`);

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are a world-class conversion copywriter who has written landing pages for companies like Basecamp, Stripe, and Linear.
Your copy is direct, benefit-focused, and structured around the customer's pain. You use proven frameworks:
- Problem → Agitate → Solution
- Features as benefits
- Social proof framing
- Clear, urgent CTAs`,
      },
      {
        role: 'user',
        content: `Write complete, conversion-optimized landing page copy for:

PRODUCT/SERVICE: ${target}

Deliver all copy sections in structured markdown:

## HEADLINE OPTIONS
3 headline variants (pick the strongest)

## SUBHEADLINE
1–2 sentences that expand on the headline promise

## HERO SECTION COPY
Opening paragraph that agitates the pain and positions the solution

## BENEFITS SECTION
5 core benefits, each with:
- Benefit headline (bold)
- 2-sentence explanation focused on customer outcome

## HOW IT WORKS
3-step process (numbered, simple, outcome-focused)

## SOCIAL PROOF SECTION
3 fabricated (clearly labeled placeholder) testimonials in the right voice + format for real testimonials

## PRICING SECTION COPY
1 CTA-focused paragraph that frames the price as a no-brainer

## FAQ SECTION
5 common objections as questions with conversion-focused answers

## FINAL CTA SECTION
- Big CTA headline
- Supporting sentence
- Button text options (3 variants)

Use vivid, specific language. Avoid corporate jargon. Write as if every word costs money.`,
      },
    ],
    temperature: 0.7,
    max_tokens: 2500,
  });

  const copy = completion.choices[0]?.message?.content?.trim() ?? 'No copy generated.';

  return `# Landing Page Copy\n**Product/Service:** ${target}\n**Date:** ${new Date().toISOString().split('T')[0]}\n**Copywriter:** CashClaw AI Agent\n\n${copy}`;
}
