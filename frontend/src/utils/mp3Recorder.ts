const MP3_BITRATE_KBPS = 128;

interface AudioContextWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

export function isMp3RecordingSupported(): boolean {
  const w = window as AudioContextWindow;
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    !!(window.AudioContext || w.webkitAudioContext)
  );
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

export interface Mp3Recording {
  blob: Blob;
  url: string;
  file: File;
}

export interface Mp3RecordingHandle {
  stop: () => Promise<Mp3Recording>;
}

/** Start capturing microphone audio, encoding it to MP3 as it streams in. */
export async function startMp3Recording(): Promise<Mp3RecordingHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const AudioContextCtor = window.AudioContext || (window as AudioContextWindow).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("Web Audio API is not supported in this browser.");

  const Mp3Encoder = window.lamejs?.Mp3Encoder;
  if (!Mp3Encoder) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("MP3 encoder failed to load.");
  }

  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  const encoder = new Mp3Encoder(1, audioContext.sampleRate, MP3_BITRATE_KBPS);
  const mp3Chunks: Int8Array[] = [];

  processor.onaudioprocess = (event) => {
    const channelData = event.inputBuffer.getChannelData(0);
    const samples = floatTo16BitPCM(channelData);
    const mp3buf = encoder.encodeBuffer(samples);
    if (mp3buf.length > 0) mp3Chunks.push(mp3buf);
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);

  return {
    stop: () =>
      new Promise<Mp3Recording>((resolve) => {
        processor.disconnect();
        source.disconnect();
        silentGain.disconnect();
        stream.getTracks().forEach((track) => track.stop());

        const remaining = encoder.flush();
        if (remaining.length > 0) mp3Chunks.push(remaining);
        void audioContext.close();

        const blob = new Blob(mp3Chunks, { type: "audio/mp3" });
        const url = URL.createObjectURL(blob);
        const file = new File([blob], `voice-message-${Date.now()}.mp3`, { type: "audio/mp3" });
        resolve({ blob, url, file });
      }),
  };
}
