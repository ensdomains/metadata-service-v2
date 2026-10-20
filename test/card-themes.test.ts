import { describe, it, expect } from 'vitest';
import { ImageGenerationService, cardTheme } from '../src/services/image';

// Renders through the real composer, so a theme that the composer ignores or
// draws on the wrong element fails here, not only in the mocked image tests.

// A 1×1 PNG, enough for the composer to draw an avatar background.
const AVATAR = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Each theme's `theme` record, as the manager app writes it, and no record (unthemed).
const RECORDS = ['#0082BB', '#984D1B', '#007C20', '#E72A96', null];

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

  it('has a distinct design theme for each record and for no record', () => {
    expect(new Set(RECORDS.map((record) => cardTheme(record).accent)).size).toBe(RECORDS.length);
  });

  for (const withAvatar of [false, true]) {
    it(`colours the tile, logo, label, name and square with the record's theme (${withAvatar ? 'avatar' : 'no avatar'})`, async () => {
      for (const themeRecord of RECORDS) {
        const theme = cardTheme(themeRecord);
        const { svg } = await service.generateDomainImage({
          name: 'jeff.eth',
          migrationStatus: 'native',
          skipAvatarLookup: true,
          themeRecord,
          ...(withAvatar ? { avatarBase64: AVATAR, avatarMimeType: 'image/png' } : {}),
        });
        const f = fills(svg);
        expect(f, String(themeRecord)).toEqual({ tile: theme.accent, logo: theme.card, label: theme.card, name: [theme.accent], square: theme.accent });
        if (withAvatar) {
          expect(svg, String(themeRecord)).toContain('<image href="data:image/png;base64,');
        } else {
          expect(svg, String(themeRecord)).toContain(`fill="${theme.card}" opacity="0.5"/>`);
        }
      }
    });
  }

  it("keeps the theme when an avatar it can't rasterize is swapped for the weave", async () => {
    const svgAvatar = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    const { svg } = await service.generateDomainImage({
      name: 'jeff.eth',
      migrationStatus: 'native',
      skipAvatarLookup: true,
      themeRecord: '#E72A96',
      avatarBase64: svgAvatar,
      avatarMimeType: 'image/svg+xml',
    });
    const rasterized = service.forRasterization(svg, 'jeff.eth', 'native');
    expect(rasterized).not.toContain('<image href="data:');
    expect(rasterized).toContain(`fill="${cardTheme('#E72A96').card}" opacity="0.5"/>`);
  });
});
