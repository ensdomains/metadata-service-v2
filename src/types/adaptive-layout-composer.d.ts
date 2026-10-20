declare module 'adaptive-layout-composer' {
  export interface SVGImageOptions {
    layout?: 'ens-v2';
    // ens-v2: trusted SVG fragment drawn as the background when there is no avatar.
    backgroundMarkup?: string | null;
    // ens-v2: label rectangle; logo tile, name and accent square; ENS logo; a subname's parent labels.
    colors?: { label?: string; accent?: string; logo?: string; parent?: string };
    // ens-v2: measures the (unescaped) name instead of the built-in measurement.
    measureText?: (text: string, fontSize: number, options: { features: string[] }) => number | Promise<number>;
    width?: number;
    height?: number;
    text?: string;
    textColor?: [number, number, number, number] | string;
    backgroundColor?: [number, number, number, number] | string;
    backgroundImageUrl?: string | null;
    textX?: number | null;
    textY?: number | null;
    maxTextWidth?: number | null;
    autoFontSize?: boolean;
    ensStyle?: boolean;
    maxFontSize?: number;
    fontSize?: number;
    fontFamily?: string;
    fontBase64?: string | null;
    customElements?: string[];
    fitMode?: 'natural' | 'exact';
  }

  export function createDynamicSVGImage(options?: SVGImageOptions): Promise<Uint8Array>;
  export function initializeFont(fontBuffer: ArrayBuffer): Promise<void>;
}
