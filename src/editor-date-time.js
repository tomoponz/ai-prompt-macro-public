// Conversion for editor datetime-local controls. Runtime scheduling still uses
// the saved ISO value; displaying it keeps the existing minute precision.
export function toDateTimeLocal(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function fromDateTimeLocal(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return "";
  return date.toISOString();
}
