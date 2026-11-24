/** Amounts are integer kobo. Formatting only; never do float math on money. */
export function formatNaira(kobo: number): string {
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(kobo));
  const naira = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}\u20A6${naira}.${String(abs % 100).padStart(2, "0")}`;
}
