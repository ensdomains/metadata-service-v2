declare module 'adaptive-layout-composer' {
  export interface SVGImageOptions {
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
    customElements?: string[];
  }

  export function createDynamicSVGImage(options?: SVGImageOptions): Promise<Uint8Array>;
}
