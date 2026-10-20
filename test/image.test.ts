import { describe, it, expect, vi } from 'vitest';
import { ImageGenerationService, cardTheme, weaveBackground } from '../src/services/image';
import { isNormalized } from '../src/utils/ens';

// Mock adaptive-layout-composer
vi.mock('adaptive-layout-composer', () => ({
  createDynamicSVGImage: vi.fn().mockResolvedValue(new TextEncoder().encode('<svg>Mock SVG</svg>')),
}));

// Mock ENS utilities
vi.mock('../src/utils/ens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/ens')>();
  return {
  ...actual,
  isNormalized: vi.fn(actual.isNormalized),
  getCharacterSet: vi.fn().mockReturnValue('latin'),
  getSegmentLength: vi.fn().mockReturnValue({ type: 'short', length: 4 }),
  };
});

describe('ImageGenerationService', () => {
  const imageService = new ImageGenerationService();

  describe('generateDomainImage', () => {
    it('should generate SVG for a normal domain', async () => {
      const result = await imageService.generateDomainImage({
        name: 'test.eth',
        migrationStatus: 'unmigrated',
      });

      expect(result.svg).toBe('<svg>Mock SVG</svg>');
      expect(result.contentType).toBe('image/svg+xml');
      expect(result.size).toEqual({ width: 518, height: 518 });
    });

    it('should handle migrated domains with different colors', async () => {
      const result = await imageService.generateDomainImage({
        name: 'migrated.eth',
        migrationStatus: 'native',
      });

      expect(result.svg).toBeDefined();
      expect(result.contentType).toBe('image/svg+xml');
    });

    it('should support custom sizes', async () => {
      const customSize = { width: 800, height: 600 };
      const result = await imageService.generateDomainImage({
        name: 'custom.eth',
        size: customSize,
      });

      expect(result.size).toEqual(customSize);
    });
  });

  describe('getImageUrl', () => {
    it('should generate correct image URL without options', () => {
      const url = imageService.getImageUrl('test.eth', 'https://example.com');
      expect(url).toBe('https://example.com/test.eth/image');
    });

    it('should include migration status in URL', () => {
      const url = imageService.getImageUrl('test.eth', 'https://example.com', {
        migrationStatus: 'native',
      });
      expect(url).toBe('https://example.com/test.eth/image?status=native');
    });

    it('should include multiple parameters', () => {
      const url = imageService.getImageUrl('test.eth', 'https://example.com', {
        migrationStatus: 'native',
        size: { width: 800, height: 600 },
      });

      expect(url).toContain('status=native');
      expect(url).toContain('w=800');
      expect(url).toContain('h=600');
    });

    it('should properly encode domain names', () => {
      const url = imageService.getImageUrl('test with spaces.eth', 'https://example.com');
      expect(url).toContain('test%20with%20spaces.eth');
    });
  });

  describe('validateOptions', () => {
    it('should validate valid options', () => {
      const validation = imageService.validateOptions({
        name: 'test.eth',
        size: { width: 500, height: 500 },
      });

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should reject empty name', () => {
      const validation = imageService.validateOptions({
        name: '',
      });

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Domain name is required');
    });

    it('should reject invalid dimensions', () => {
      const validation = imageService.validateOptions({
        name: 'test.eth',
        size: { width: 50, height: 3000 },
      });

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Width must be between 100 and 2000 pixels');
      expect(validation.errors).toContain('Height must be between 100 and 2000 pixels');
    });

    it('should accept valid dimensions', () => {
      const validation = imageService.validateOptions({
        name: 'test.eth',
        size: { width: 500, height: 500 },
      });

      expect(validation.valid).toBe(true);
    });
  });

  describe('card by migration status', () => {
    async function composerOptions(migrationStatus: 'unmigrated' | 'migrated' | 'native', size?: { width: number; height: number }) {
      const { createDynamicSVGImage } = await import('adaptive-layout-composer');
      const mockCreateSVG = vi.mocked(createDynamicSVGImage);
      mockCreateSVG.mockClear();
      await imageService.generateDomainImage({ name: 'test.eth', migrationStatus, size });
      return mockCreateSVG.mock.calls[0][0];
    }

    it('keeps the v1 card, with no badge or indicator, for a name not on ENS v2', async () => {
      const opts = await composerOptions('unmigrated');
      expect(opts).not.toHaveProperty('layout');
      expect(opts).not.toHaveProperty('customElements');
      expect(opts).toMatchObject({ text: 'test.eth', textColor: '#F9FAFB', backgroundColor: '#1F2937' });
    });

    it.each(['migrated', 'native'] as const)('draws the ENS v2 card, with no badge or indicator, for a %s name', async (status) => {
      const opts = await composerOptions(status);
      expect(opts).toMatchObject({ layout: 'ens-v2', text: 'test.eth', backgroundImageUrl: null });
      expect(opts).not.toHaveProperty('customElements');
    });

    it("draws an ENS v2 name's weave when it has no avatar", async () => {
      const opts = await composerOptions('migrated', { width: 800, height: 600 });
      expect(opts?.backgroundMarkup).toBe(weaveBackground('test.eth', 800, 600));
    });

    it("colours the ENS v2 card's logo tile, label, name and square with the name's theme", async () => {
      const theme = cardTheme('test.eth');
      const opts = await composerOptions('native');
      expect(opts?.colors).toEqual({ accent: theme.accent, label: theme.card, logo: theme.card, parent: theme.weave });
      expect(weaveBackground('test.eth', 550, 550)).toContain(`fill="${theme.card}" opacity="0.5"`);
    });

    it('gives every design theme to some name', () => {
      const accents = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((l) => cardTheme(`${l}.eth`).accent));
      expect(accents.size).toBe(5);
    });
  });

  describe('user-content safety (XSS)', () => {
    it('never puts the text of a name that is not normalized into the SVG', async () => {
      const { createDynamicSVGImage } = await import('adaptive-layout-composer');
      const mockCreateSVG = vi.mocked(createDynamicSVGImage);
      mockCreateSVG.mockClear();

      await imageService.generateDomainImage({ name: 'evil</text><script>alert(1)</script>.eth' });

      // Shown as its token id, shortened (as v1).
      expect((mockCreateSVG.mock.calls[0][0] as { text: string }).text).toMatch(/^\[0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}\]\.eth$/);
    });

    it('escapes XML-special characters in a name it draws (defense in depth)', async () => {
      const { createDynamicSVGImage } = await import('adaptive-layout-composer');
      const mockCreateSVG = vi.mocked(createDynamicSVGImage);
      mockCreateSVG.mockClear();
      vi.mocked(isNormalized).mockReturnValue(true); // as if it passed normalization

      await imageService.generateDomainImage({ name: 'evil</text><script>alert(1)</script>.eth' });
      const actual = await vi.importActual<typeof import('../src/utils/ens')>('../src/utils/ens');
      vi.mocked(isNormalized).mockImplementation(actual.isNormalized);

      const passedText = (mockCreateSVG.mock.calls[0][0] as { text: string }).text;
      expect(passedText).not.toMatch(/[<>]/);            // no raw angle brackets reach the SVG markup
      expect(passedText).toContain('&lt;script&gt;');    // escaped form instead
    });

    it('leaves a normalized name unchanged (escape is identity for legit names)', async () => {
      const { createDynamicSVGImage } = await import('adaptive-layout-composer');
      const mockCreateSVG = vi.mocked(createDynamicSVGImage);
      mockCreateSVG.mockClear();

      await imageService.generateDomainImage({ name: 'vitalik.eth' });

      expect((mockCreateSVG.mock.calls[0][0] as { text: string }).text).toBe('vitalik.eth');
    });
  });

  describe('card name text (ENSIP-15 ens_beautify)', () => {
    // A normalized name has no FE0F; the card shows the name as ENS displays it,
    // with FE0F on every emoji, so 🧙🏻‍♂ is drawn as an emoji and not left blank.
    const textFor = async (name: string) => {
      const { createDynamicSVGImage } = await import('adaptive-layout-composer');
      const mockCreateSVG = vi.mocked(createDynamicSVGImage);
      mockCreateSVG.mockClear();
      await imageService.generateDomainImage({ name });
      return (mockCreateSVG.mock.calls[0][0] as { text: string }).text;
    };

    it.each([
      ['a ZWJ emoji sequence', '\u{1F98A}\u{1F9D9}\u{1F3FB}\u200D\u2642.eth', '\u{1F98A}\uFE0F\u{1F9D9}\u{1F3FB}\u200D\u2642\uFE0F.eth'],
      ['an emoji with a text default', '\u2764.eth', '\u2764\uFE0F.eth'],
      ['a Greek xi outside a Greek label', '\u03BE.eth', '\u039E.eth'],
    ])('beautifies %s', async (_label, name, shown) => {
      expect(await textFor(name)).toBe(shown);
    });

    it('shows a name that is not normalized as its token id, shortened (as v1)', async () => {
      expect(await textFor('ab_c.eth')).toBe('[0xf96b...0db8].eth'); // labelhash('ab_c')
    });
  });

  describe('error handling', () => {
    it('should handle SVG generation errors', async () => {
      const { createDynamicSVGImage } = await import('adaptive-layout-composer');
      vi.mocked(createDynamicSVGImage).mockRejectedValueOnce(new Error('SVG generation failed'));

      await expect(
        imageService.generateDomainImage({ name: 'test.eth' })
      ).rejects.toThrow('Failed to generate image for test.eth');
    });
  });
});