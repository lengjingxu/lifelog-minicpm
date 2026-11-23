import { useState } from "react";
import clsx from "clsx";
import { Check, ChevronDown, ImageOff, LoaderCircle, Play } from "lucide-react";
import { assetSrc, type DupGroupPageGroup, type DupGroupMember } from "../api";
import { formatBytes } from "../utils";

const VISIBLE = 8;

type Props = {
  groups: DupGroupPageGroup[];
  /** 已在待清理清单里的 id。 */
  queued: Set<string>;
  /** 点缩略图 = 整组切换待清理。 */
  onToggleGroup: (group: DupGroupPageGroup) => void;
  /** 组头按钮：除 keeper 外整组加入 / 整组移出。 */
  onToggleCandidates: (ids: string[], add: boolean) => void;
  loadingMore?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
};

/** 重复图视角：按组分区展示，keeper 第一、其余按分数降序。 */
export function DupGroupBoard({
  groups,
  queued,
  onToggleGroup,
  onToggleCandidates,
  loadingMore = false,
  hasMore = false,
  onLoadMore,
}: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <div className="dup-board">
      {groups.map((group, index) => {
        const members = group.members;
        const keeper = members.find((member) => member.is_keeper) ?? members[0];
        const candidates = members.filter((member) => member.id !== keeper?.id).map((member) => member.id);
        const queuedCount = candidates.filter((id) => queued.has(id)).length;
        const allQueued = candidates.length > 0 && queuedCount === candidates.length;
        const isOpen = Boolean(expanded[group.key]);
        const shown = isOpen ? members : members.slice(0, VISIBLE);
        const hidden = members.length - shown.length;

        return (
          <section
            key={group.key}
            className={clsx("dup-group", queuedCount > 0 && "queued")}
            data-group-key={group.key}
            data-count={members.length}
          >
            <header className="dup-group-head">
              <div className="dup-group-title">
                <strong>组 {index + 1}</strong>
                <span>{group.label}</span>
                <span>{members.length} 张</span>
                <span>可回收 {formatBytes(group.reclaim_bytes)}</span>
                {queuedCount > 0 && <em className="dup-group-queued">已加入 {queuedCount} 张</em>}
              </div>
              <button
                type="button"
                className="dup-group-action"
                onClick={() => onToggleCandidates(candidates, !allQueued)}
                disabled={!candidates.length}
                title={allQueued ? "把这一组移出待清理" : "把 keeper 之外的成员加入待清理"}
              >
                {allQueued ? "整组移出" : "整组加入待清理"}
              </button>
            </header>

            <div className={clsx("dup-group-thumbs", isOpen && "expanded")}>
              {shown.map((member) => (
                <DupThumb
                  key={member.id}
                  member={member}
                  queued={queued.has(member.id)}
                  onToggle={() => onToggleGroup(group)}
                />
              ))}
              {hidden > 0 && (
                <button
                  type="button"
                  className="dup-more"
                  onClick={() => setExpanded((previous) => ({ ...previous, [group.key]: true }))}
                  aria-label={"+ " + hidden + " 张，展开这一组"}
                >
                  +{hidden}
                </button>
              )}
              {isOpen && members.length > VISIBLE && (
                <button
                  type="button"
                  className="dup-more collapse"
                  onClick={() => setExpanded((previous) => ({ ...previous, [group.key]: false }))}
                  aria-label="收起这一组"
                >
                  <ChevronDown size={13} strokeWidth={2} />
                </button>
              )}
            </div>
          </section>
        );
      })}

      <div className="dup-board-foot">
        {loadingMore ? (
          <span>
            <LoaderCircle size={12} className="spin" /> 载入中…
          </span>
        ) : hasMore ? (
          <button
            type="button"
            className="ghost-button"
            onClick={() => onLoadMore?.()}
          >
            继续下滑加载更多
          </button>
        ) : groups.length > 0 ? (
          <span>已到底 · 共 {groups.length} 组</span>
        ) : null}
      </div>
    </div>
  );
}

function DupThumb({
  member,
  queued,
  onToggle,
}: {
  member: DupGroupMember;
  queued: boolean;
  onToggle: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const score = member.score == null ? null : member.score.toFixed(1);
  return (
    <button
      type="button"
      className={clsx("dup-thumb", member.is_keeper && "keeper", queued && "queued")}
      data-asset-id={member.id}
      title={member.path}
      aria-label={(member.is_keeper ? "保留 · " : "") + member.path.split("/").pop()}
      aria-pressed={queued}
      onClick={onToggle}
    >
      {!failed && member.thumb ? (
        <img
          src={assetSrc(member.thumb)}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="dup-thumb-empty">
          <ImageOff size={14} strokeWidth={1.5} />
          <em>{formatBytes(member.size ?? undefined)}</em>
        </span>
      )}
      {member.kind === "video" && (
        <span className="dup-thumb-play" aria-hidden="true">
          <Play size={9} fill="currentColor" strokeWidth={0} />
        </span>
      )}
      {member.is_keeper ? (
        <span className="dup-thumb-flag keeper">保留</span>
      ) : (
        score && <span className="dup-thumb-flag score">{score}</span>
      )}
      <span className="dup-thumb-check" aria-hidden="true">
        {queued && <Check size={10} strokeWidth={2.6} />}
      </span>
    </button>
  );
}
