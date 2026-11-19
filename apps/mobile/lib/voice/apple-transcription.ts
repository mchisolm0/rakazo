/** SpeechAnalyzer exists only on iOS; see apple-transcription.ios.ts. */
export function appleTranscriber(_lang: string): ((uri: string) => Promise<string>) | null {
  return null;
}
