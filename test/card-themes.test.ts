import { describe, it, expect } from 'vitest';
import { ImageGenerationService, cardTheme } from '../src/services/image';

// Renders through the real composer, so a theme that the composer ignores or
// draws on the wrong element fails here, not only in the mocked image tests.

// A 1×1 PNG, enough for the composer to draw an avatar background.
const AVATAR = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// One name per theme, found the same way the service picks a theme.
function namePerTheme(): Map<string, string> {
  const names = new Map<string, string>();
  for (let i = 0; names.size < 5 && i < 1000; i++) {
    const name = `theme${i}.eth`;
    const { accent } = cardTheme(name);
    if (!names.has(accent)) names.set(accent, name);
  }
  return names;
}

function fills(svg: string) {
  return {
    tile: svg.match(/<rect x="12" y="478" width="60" height="60" rx="6" fill="([^"]+)"\/>/)?.[1],
    logo: svg.match(/<path fill-rule="evenodd" clip-rule="evenodd" d="M42\.7634[^"]+" fill="([^"]+)"\/>/)?.[1],
    label: svg.match(/<rect x="74" y="[\d.]+" width="[\d.]+" height="[\d.]+" rx="6" fill="([^"]+)"\/>/)?.[1],
    name: [...svg.matchAll(/<text [^>]*fill="([^"]+)"[^>]*>/g)].map((m) => m[1]),
    square: svg.match(/<rect x="[\d.]+" y="[\d.-]+" width="32" height="32" rx="6" fill="([^"]+)"\/>/)?.[1],
  };
}

describe('ENS v2 card themes in the rendered SVG', () => {
  const service = new ImageGenerationService();
  const names = namePerTheme();

  it('reaches every theme', () => {
    expect(names.size).toBe(5);
  });

  for (const withAvatar of [false, true]) {
    it(`colours the tile, logo, label, name and square with the name's theme (${withAvatar ? 'avatar' : 'no avatar'})`, async () => {
      for (const name of names.values()) {
        const theme = cardTheme(name);
        const { svg } = await service.generateDomainImage({
          name,
          migrationStatus: 'native',
          skipAvatarLookup: true,
          ...(withAvatar ? { avatarBase64: AVATAR, avatarMimeType: 'image/png' } : {}),
        });
        const f = fills(svg);
        expect(f, name).toEqual({ tile: theme.accent, logo: theme.card, label: theme.card, name: [theme.accent], square: theme.accent });
        if (withAvatar) {
          expect(svg, name).toContain('<image href="data:image/png;base64,');
        } else {
          expect(svg, name).toContain(`fill="${theme.card}" opacity="0.5"/>`);
        }
      }
    });
  }
});
