import { describe, it, expect, vi } from 'vitest';
import { ImageGenerationService } from '../src/services/image';

// Mock adaptive-layout-composer
vi.mock('adaptive-layout-composer', () => ({
  createDynamicSVGImage: vi.fn().mockResolvedValue('<svg>Mock SVG</svg>'),
}));

// Mock ENS utilities
vi.mock('../src/utils/ens', () => ({
  getCharacterSet: vi.fn().mockReturnValue('latin'),
  getSegmentLength: vi.fn().mockReturnValue({ type: 'short', length: 4 }),
}));

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
        style: 'modern',
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

    it('should handle different background types', async () => {
      for (const background of ['gradient', 'solid', 'pattern']) {
        const result = await imageService.generateDomainImage({
          name: 'test.eth',
          background: background as 'gradient' | 'solid' | 'pattern',
        });

        expect(result.svg).toBeDefined();
      }
    });

    it('should handle different styles', async () => {
      for (const style of ['classic', 'modern', 'minimal']) {
        const result = await imageService.generateDomainImage({
          name: 'test.eth',
          style: style as 'classic' | 'modern' | 'minimal',
        });

        expect(result.svg).toBeDefined();
      }
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
        style: 'modern',
        background: 'gradient',
        size: { width: 800, height: 600 },
      });

      expect(url).toContain('status=native');
      expect(url).toContain('style=modern');
      expect(url).toContain('bg=gradient');
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

  describe('color schemes', () => {
    it('should use different colors for different migration statuses', async () => {
      const { createDynamicSVGImage } = await import('adaptive-layout-composer');
      const mockCreateSVG = vi.mocked(createDynamicSVGImage);

      // Test different migration statuses
      for (const status of ['unmigrated', 'native', 'migrated']) {
        mockCreateSVG.mockClear();

        await imageService.generateDomainImage({
          name: 'test.eth',
          migrationStatus: status as 'migrated' | 'native' | 'unmigrated',
        });

        expect(mockCreateSVG).toHaveBeenCalledWith(
          expect.objectContaining({
            text: 'test.eth',
            textColor: expect.any(String),
            backgroundColor: expect.any(String),
          })
        );
      }
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