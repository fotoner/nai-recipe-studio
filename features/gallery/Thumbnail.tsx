import type { CSSProperties } from "react";
/** Native image loading replaces Next Image while preserving the original thumbnail geometry. */
export function Thumbnail({ src, alt, fill, sizes, className }: { src: string; alt: string; fill?: boolean; sizes?: string; className?: string }) {
  const style: CSSProperties | undefined = fill ? { position: "absolute", width: "100%", height: "100%", inset: 0 } : undefined;
  return <img src={src} alt={alt} sizes={sizes} className={className} style={style} loading="lazy" decoding="async" />;
}
