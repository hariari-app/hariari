/** Parses the one durable/public UTC representation accepted by Runtime. */
export function parseCanonicalUtcTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error('invalid canonical UTC timestamp');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error('invalid canonical UTC timestamp');
  }
  return value;
}
