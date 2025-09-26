declare module 'adaptive-layout-composer' {
  export interface SVGImageOptions {
    text: string;
    width: number;
    height: number;
    autoFontSize?: boolean;
    minFontSize?: number;
    maxFontSize?: number;
    textColor?: string;
    backgroundColor?: string;
    padding?: number;
    fontFamily?: string;
    textAlign?: 'left' | 'center' | 'right';
    verticalAlign?: 'top' | 'middle' | 'bottom';
    customElements?: string[];
  }

  export function createDynamicSVGImage(options: SVGImageOptions): Promise<string>;
}