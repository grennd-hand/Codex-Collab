export interface HostWorkAdmission {
  isAllowed(): boolean;
}

export function hostWorkAllowed(admission?: HostWorkAdmission): boolean {
  return admission?.isAllowed() ?? true;
}
