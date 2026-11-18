import { useEffect, useMemo, useRef, useState } from "react";
import { Check, FolderPlus, Images, LoaderCircle, X } from "lucide-react";
import clsx from "clsx";
import { albumAdd, albumList, type Album } from "../api";
import { useDialogFocus } from "../useDialogFocus";

type Origin = { x: number; y: number; width: number; height: number } | null;

type Props = {
  /** 要加入相册的照片 id；详情页传一条，批量条传全部选中。 */
  assetIds: string[];
  origin?: Origin;
  onCancel: () => void;
  onAdded: (album: string, created: boolean) => void;
};

/** 「加入相册」：已有相册列出来，也可以直接输入新名字建；一次可以带多张。 */
export function AlbumPicker({ assetIds, origin = null, onCancel, onAdded }: Props) {
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(onCancel, { growFrom: origin });

  const ids = useMemo(() => Array.from(new Set(assetIds)).filter(Boolean), [assetIds]);

  useEffect(() => {
    let alive = true;
    albumList()
      .then((result) => {
        if (alive) setAlbums(result.albums ?? []);
      })
      .catch(() => {
        if (alive) setAlbums([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || busy || !ids.length) return;
    setBusy(trimmed);
    setError(null);
    try {
      const created = !(albums ?? []).some((album) => album.name === trimmed);
      const result = await albumAdd(trimmed, ids);
      if (!result.ok) throw new Error("加入相册没有返回成功");
      onAdded(trimmed, created);
    } catch (reason: unknown) {
      setError(String(reason).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className="dialog delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="加入相册"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="delete-title">加入相册</h2>
        <p className="delete-note">
          {ids.length > 1
            ? `把选中的 ${ids.length} 张加进一个相册，或输入新名字直接建。`
            : "选一个已有相册，或输入新名字直接建。"}
        </p>

        <div className="album-picker-list" role="listbox" aria-label="已有相册">
          {albums === null ? (
            <span className="album-picker-empty"><LoaderCircle size={13} className="spin" /> 读取相册…</span>
          ) : albums.length === 0 ? (
            <span className="album-picker-empty"><Images size={14} /> 还没有相册，直接在下面输入一个名字。</span>
          ) : (
            albums.map((album) => (
              <button
                key={album.id}
                type="button"
                role="option"
                aria-selected={false}
                className={clsx("album-picker-item", busy === album.name && "busy")}
                disabled={Boolean(busy)}
                onClick={() => void submit(album.name)}
              >
                <FolderPlus size={13} strokeWidth={1.8} />
                <span>{album.name}</span>
                <em>{album.count} 张</em>
                {busy === album.name ? <LoaderCircle size={12} className="spin" /> : <Check size={12} className="album-picker-check" />}
              </button>
            ))
          )}
        </div>

        <div className="album-picker-new">
          <input
            ref={inputRef}
            value={value}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit(value);
              }
            }}
            placeholder="或输入新相册名"
            aria-label="新相册名"
            disabled={Boolean(busy)}
          />
          <button type="button" className="primary-btn" onClick={() => void submit(value)} disabled={!value.trim() || Boolean(busy)}>
            {busy === value.trim() ? <LoaderCircle size={12} className="spin" /> : <PlusIcon />}
            新建并加入
          </button>
        </div>

        {error && <p className="album-picker-error">{error}</p>}

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={Boolean(busy)}>
            <X size={13} /> 取消
          </button>
        </div>
      </div>
    </div>
  );
}

function PlusIcon() {
  return <FolderPlus size={12} strokeWidth={1.9} />;
}
