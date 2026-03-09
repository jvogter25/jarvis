import { upsertFile, getFileContent, listFiles } from '../github/client.js';
import { interactWithPage } from './browser.js';

const JARVIS_REPO = 'jarvis';
const DESIGN_TOKENS_PATH = 'design-refs/design-tokens.json';
const COMPONENTS_PATH = 'design-refs/components';
const INSPIRATION_PATH = 'design-refs/inspiration';

export interface DesignTokens {
  colors: Record<string, string>;
  fonts: Record<string, string>;
  radius: Record<string, string>;
  spacing: Record<string, string>;
  sources: string[];
}

const DEFAULT_TOKENS: DesignTokens = {
  colors: {
    primary: '#0066FF',
    background: '#0A0A0A',
    surface: '#1A1A1A',
    text: '#FFFFFF',
    accent: '#00D4FF',
    muted: '#888888',
  },
  fonts: {
    heading: 'Inter',
    body: 'Inter',
    mono: 'JetBrains Mono',
  },
  radius: {
    card: '12px',
    button: '8px',
    input: '6px',
    full: '9999px',
  },
  spacing: {
    section: '80px',
    card: '24px',
    gap: '16px',
  },
  sources: [],
};

export async function readDesignTokens(): Promise<DesignTokens> {
  const raw = await getFileContent(JARVIS_REPO, DESIGN_TOKENS_PATH);
  if (!raw) return DEFAULT_TOKENS;
  try {
    return JSON.parse(raw) as DesignTokens;
  } catch {
    return DEFAULT_TOKENS;
  }
}

export async function updateDesignTokens(
  updates: Partial<DesignTokens>,
  sourceNote?: string
): Promise<void> {
  const current = await readDesignTokens();
  const merged: DesignTokens = {
    colors: { ...current.colors, ...(updates.colors ?? {}) },
    fonts: { ...current.fonts, ...(updates.fonts ?? {}) },
    radius: { ...current.radius, ...(updates.radius ?? {}) },
    spacing: { ...current.spacing, ...(updates.spacing ?? {}) },
    sources: sourceNote
      ? [...current.sources, `${sourceNote} — ${new Date().toISOString().slice(0, 10)}`]
      : current.sources,
  };
  await upsertFile(
    JARVIS_REPO,
    DESIGN_TOKENS_PATH,
    JSON.stringify(merged, null, 2) + '\n',
    `feat: update design tokens${sourceNote ? ` from ${sourceNote}` : ''}`
  );
}

export async function extractCssFromUrl(url: string): Promise<Partial<DesignTokens>> {
  const playwrightCode = `
    const extracted = await page.evaluate(() => {
      const cssVars = {};
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule instanceof CSSStyleRule && (rule.selectorText === ':root' || rule.selectorText === 'html')) {
              const matches = rule.cssText.matchAll(/(--[\\w-]+):\\s*([^;]+)/g);
              for (const m of matches) {
                cssVars[m[1].trim()] = m[2].trim();
              }
            }
          }
        } catch (e) {}
      }
      const bodyStyle = window.getComputedStyle(document.body);
      const h1 = document.querySelector('h1');
      const h1Style = h1 ? window.getComputedStyle(h1) : null;
      return {
        cssVars,
        bgColor: bodyStyle.backgroundColor,
        textColor: bodyStyle.color,
        bodyFont: bodyStyle.fontFamily.split(',')[0].replace(/['"]/g, '').trim(),
        headingFont: h1Style ? h1Style.fontFamily.split(',')[0].replace(/['"]/g, '').trim() : null,
      };
    });
    console.log(JSON.stringify(extracted));
  `;

  const result = await interactWithPage(url, playwrightCode);
  if (result.error) {
    console.error('CSS extraction failed:', result.error);
    return {};
  }

  try {
    const data = JSON.parse(result.result) as {
      cssVars: Record<string, string>;
      bgColor: string;
      textColor: string;
      bodyFont: string;
      headingFont: string | null;
    };

    const tokens: Partial<DesignTokens> = { colors: {}, fonts: {} };

    const varMap: Record<string, [keyof DesignTokens, string]> = {
      '--primary': ['colors', 'primary'],
      '--primary-color': ['colors', 'primary'],
      '--color-primary': ['colors', 'primary'],
      '--background': ['colors', 'background'],
      '--foreground': ['colors', 'text'],
      '--accent': ['colors', 'accent'],
      '--border-radius': ['radius', 'card'],
      '--radius': ['radius', 'card'],
      '--font-sans': ['fonts', 'body'],
      '--font-heading': ['fonts', 'heading'],
    };

    for (const [varName, value] of Object.entries(data.cssVars)) {
      const mapping = varMap[varName];
      if (mapping) {
        const [category, key] = mapping;
        (tokens[category] as Record<string, string>)[key] = value;
      }
    }

    if (data.bgColor && data.bgColor !== 'rgba(0, 0, 0, 0)') {
      tokens.colors!['background'] = data.bgColor;
    }
    if (data.textColor) tokens.colors!['text'] = data.textColor;
    if (data.headingFont && data.headingFont !== 'sans-serif') {
      tokens.fonts!['heading'] = data.headingFont;
    }
    if (data.bodyFont && data.bodyFont !== 'sans-serif') {
      tokens.fonts!['body'] = data.bodyFont;
    }

    return tokens;
  } catch {
    return {};
  }
}

export async function saveComponent(name: string, code: string): Promise<void> {
  const fileName = name.replace(/\s+/g, '-').toLowerCase() + '.tsx';
  await upsertFile(
    JARVIS_REPO,
    `${COMPONENTS_PATH}/${fileName}`,
    code,
    `feat: add design component ${name}`
  );
}

export async function saveInspiration(fileName: string, imageBase64: string): Promise<void> {
  await upsertFile(
    JARVIS_REPO,
    `${INSPIRATION_PATH}/${fileName}`,
    imageBase64,
    `feat: add design inspiration ${fileName}`
  );
}

export async function scanDesignLibrary(): Promise<{
  components: string[];
  tokenSummary: string;
}> {
  const [components, tokens] = await Promise.all([
    listFiles(JARVIS_REPO, COMPONENTS_PATH),
    readDesignTokens(),
  ]);
  const tokenSummary = [
    `Colors: primary=${tokens.colors.primary}, bg=${tokens.colors.background}`,
    `Fonts: heading=${tokens.fonts.heading}, body=${tokens.fonts.body}`,
    `${tokens.sources.length} sites extracted`,
  ].join('. ');

  return {
    components: components.filter(f => f.endsWith('.tsx')),
    tokenSummary,
  };
}

export function generateCssVars(tokens: DesignTokens): string {
  const vars = [
    ...Object.entries(tokens.colors).map(([k, v]) => `  --color-${k}: ${v};`),
    ...Object.entries(tokens.fonts).map(([k, v]) => `  --font-${k}: "${v}", sans-serif;`),
    ...Object.entries(tokens.radius).map(([k, v]) => `  --radius-${k}: ${v};`),
    ...Object.entries(tokens.spacing).map(([k, v]) => `  --spacing-${k}: ${v};`),
  ].join('\n');
  return `:root {\n${vars}\n}\n`;
}
