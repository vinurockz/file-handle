export interface BlockStyle {
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  marginTop?: number;
  marginBottom?: number;
  paddingY?: number;
  paddingX?: number;
  marginY?: number;
  background?: string;
  backgroundImage?: string;
  color?: string;
  fontSize?: number;
  fontWeight?: number;
  align?: 'left' | 'center' | 'right';
  radius?: number;
  borderWidth?: number;
  borderColor?: string;
  maxWidth?: number;
  opacity?: number;
  hideOnMobile?: boolean;
}

export type Props = Record<string, unknown>;

export interface SiteBlock {
  id: string;
  kind: string;
  props: Props;
  style: BlockStyle;
  /** Only the columns block has children: one list per column. */
  columns?: SiteBlock[][];
}

export interface SiteTheme {
  name: string;
  themeColor: string;
  fontFamily: string;
  textColor: string;
  backgroundColor: string;
  faviconMediaId?: string | null;
}

export interface RenderContext {
  mediaSrc(id: string): string;
  pageHref(slug: string): string;
  /** True for the editor canvas, which tags blocks so they can be clicked. */
  editing: boolean;
}

export type Field =
  | {
      key: string;
      label: string;
      type: 'text' | 'textarea' | 'code' | 'rich' | 'color' | 'checkbox' | 'link' | 'datetime';
    }
  | { key: string; label: string; type: 'number'; min: number; max: number; unit: string }
  | { key: string; label: string; type: 'select'; options: [string, string][] }
  | { key: string; label: string; type: 'media'; kind: 'image' | 'video' }
  | { key: string; label: string; type: 'gallery' }
  | {
      key: string;
      label: string;
      type: 'list';
      itemLabel: string;
      fields: Field[];
      blank: () => Props;
    };

export interface BlockDef {
  kind: string;
  label: string;
  icon: string;
  group: 'Layout' | 'Text' | 'Media' | 'Marketing' | 'Interactive';
  defaults(): Props;
  fields: Field[];
  render(
    block: SiteBlock,
    context: RenderContext,
    children: (blocks: SiteBlock[]) => string,
  ): string;
}
