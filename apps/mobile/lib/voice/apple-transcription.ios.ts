import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { File } from "expo-file-system";

/**
 * iOS 26's on-device SpeechAnalyzer, which transcribes a finished recording in one pass, so
 * pauses never cut a message short. Null where the device lacks it.
 */
export function appleTranscriber(lang: string): ((uri: string) => Promise<string>) | null {
  if (!AppleTranscription.isAvailable(lang)) return null;
  return async (uri) => {
    // Downloads the language's model the first time; later calls return at once.
    await AppleTranscription.prepare(lang);
    const result = await AppleTranscription.transcribe(await new File(uri).arrayBuffer(), lang);
    return result.segments
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  };
}
