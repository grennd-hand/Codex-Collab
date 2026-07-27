import { Skeleton, SkeletonItem } from "@fluentui/react-components";

export function MemberSkeleton() {
  return (
    <Skeleton aria-label="正在加载成员">
      <div className="member-skeleton">
        <SkeletonItem shape="circle" size={32} />
        <div>
          <SkeletonItem size={12} />
          <SkeletonItem size={8} />
        </div>
      </div>
      <div className="member-skeleton">
        <SkeletonItem shape="circle" size={32} />
        <div>
          <SkeletonItem size={12} />
          <SkeletonItem size={8} />
        </div>
      </div>
    </Skeleton>
  );
}
