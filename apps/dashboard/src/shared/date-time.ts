const shortTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
});

export function shortTimeLabel(value: string): string {
  return shortTimeFormatter.format(new Date(value));
}
