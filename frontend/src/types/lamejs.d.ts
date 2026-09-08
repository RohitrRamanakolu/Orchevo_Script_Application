/**
 * lamejs's browser bundle (public/lame.min.js) is a classic global-scope
 * script loaded via <script src>, not an ES/CommonJS module — it attaches
 * a `lamejs` namespace to `window`.
 */
export {};

interface LameJsMp3Encoder {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
  flush(): Int8Array;
}

interface LameJsNamespace {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => LameJsMp3Encoder;
}

declare global {
  interface Window {
    lamejs?: LameJsNamespace;
  }
}
