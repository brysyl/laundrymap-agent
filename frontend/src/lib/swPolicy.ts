/** Update prompt policy: the page may only reload for a new service worker when no submission is active. */
export function canApplyUpdate(activeSubmissions: boolean, queuedRequests: number): boolean {
  return !activeSubmissions && queuedRequests === 0;
}
