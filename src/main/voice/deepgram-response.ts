interface DeepgramTranscriptionResponse {
  readonly results?: {
    readonly channels?: ReadonlyArray<{
      readonly alternatives?: ReadonlyArray<{ readonly transcript?: string }>;
    }>;
  };
}

export function extractDeepgramTranscript(result: unknown): string {
  const response = result as DeepgramTranscriptionResponse;
  return response.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? '';
}
