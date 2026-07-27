import { shortTimeLabel } from "../../shared/date-time.js";

export interface ActivityItem {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
  tone: "info" | "success" | "warning" | "danger";
}

export interface ActivityPanelProps {
  activities: ActivityItem[];
}

export function ActivityPanel({ activities }: ActivityPanelProps) {
  return (
    <aside
      className="activity-panel"
      aria-label="任务活动"
      data-workspace-panel="activity"
    >
      <div className="panel-heading">
        <div>
          <h2>任务活动</h2>
          <p>最近的协作事件</p>
        </div>
        <span>实时</span>
      </div>
      <div className="activity-list">
        {activities.map((item) => (
          <div className={`activity-item ${item.tone}`} key={item.id}>
            <div className="activity-line" aria-hidden="true">
              <span />
            </div>
            <div>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
              <time dateTime={item.createdAt}>
                {shortTimeLabel(item.createdAt)}
              </time>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
