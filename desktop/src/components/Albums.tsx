
import { useEffect, useState } from "react";
import { Folder } from "lucide-react";
import { assetSrc, type AlbumSummary } from "../api";

type Props = {
  albums: AlbumSummary[];
  loading: boolean;
  onPick: (name: string) => void;
};

function Img({ thumb, className }: { thumb: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [thumb]);
  if (!thumb || failed) {
    return <span className={[className, "album-fallback"].filter(Boolean).join(" ")} aria-hidden="true" />;
  }
  return (
    <img
      src={assetSrc(thumb)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * 相册卡片：封面取相册里美学分最高的一张，右上角跟 3 张预览。
 * 点卡片就把相册作为筛选条件回到图库。
 */
export function Albums({ albums, loading, onPick }: Props) {
  if (loading) return <div className="category-loading">正在读取相册…</div>;
  if (albums.length === 0) return <div className="category-loading">还没有相册。选中照片后可以加入相册。</div>;

  return (
    <div className="category-scroll">
      <div className="category-head">
        <div className="category-icon">
          <Folder size={17} strokeWidth={1.6} />
        </div>
        <div>
          <div className="category-eyebrow">ALBUMS</div>
          <h2>相册</h2>
          <p>封面取相册里美学分最高的一张，右上角是接下来的三张。</p>
        </div>
        <div className="category-total">
          <span>{albums.length}</span>
          <small>本相册</small>
        </div>
      </div>

      <div className="category-grid">
        {albums.map((album, index) => (
          <button
            type="button"
            className="category-card album-card"
            key={album.name}
            onClick={() => onPick(album.name)}
            style={{ animationDelay: Math.min(index, 10) * 24 + "ms" }}
          >
            <span className="category-cover">
              <Img thumb={album.cover_thumb} className="album-cover-img" />
            </span>
            {album.preview_thumb.length > 0 && (
              <span className="album-previews" aria-hidden="true">
                {album.preview_thumb.map((thumb, i) => (
                  <Img key={thumb + i} thumb={thumb} className="album-preview" />
                ))}
              </span>
            )}
            <span className="category-front glass-surface on-color">
              <span className="category-meta">
                <span className="category-name">
                  <Folder size={12} strokeWidth={1.8} />
                  {album.name}
                </span>
                <span className="category-count">{album.count} 张</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

