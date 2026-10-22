'use client';

// The message input bar: quick suggestion chips above, a growing text field
// with a voice (mic) button and a coral send button below. Enter submits;
// Shift+Enter inserts a newline. Voice uses the browser SpeechRecognition API —
// speak, watch the transcript fill live, and it sends when you pause.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { stripMarkers } from './markers';

export interface ComposerProps {
  onSend: (
    text: string,
    image?: { mediaType: string; data: string },
  ) => void;
  disabled?: boolean;
  // abort the in-flight reply — when set and `disabled` (a turn is streaming),
  // the send button becomes a Stop button.
  onStop?: () => void;
  // dynamic, service-aware quick chips (tap to send instantly)
  suggestions?: string[];
  placeholder?: string;
  // latest completed assistant reply — read aloud in hands-free mode
  lastReply?: string;
}

// Photo attach limits. Everything is re-encoded to a ≤1280px JPEG before
// upload, so the cap below only guards decode memory on huge originals.
const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic', // decodes on Safari; other browsers fail -> friendly error
  'image/heif',
];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_IMAGE_EDGE = 1280;

type AttachedImage = { mediaType: string; data: string; preview: string };

/** Validate a picked/pasted/dropped file; returns a user-facing error or null. */
function imageError(file: File): string | null {
  const type = file.type.toLowerCase();
  if (type && !ACCEPTED_IMAGE_TYPES.includes(type)) {
    return 'That file type isn’t supported — attach a JPG, PNG or WebP photo.';
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return `That photo is ${Math.round(file.size / (1024 * 1024))} MB — please use one under 20 MB.`;
  }
  return null;
}

// Decode with createImageBitmap (no giant data-URL string in memory), falling
// back to an object-URL <img> where it's unavailable.
async function decodeImage(
  file: File,
): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img: HTMLImageElement = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Downscale (max 1280px) and re-encode as JPEG so the upload stays small/fast.
async function downscaleImage(file: File): Promise<AttachedImage> {
  const decoded = await decodeImage(file);
  try {
    let w = decoded.width;
    let h = decoded.height;
    if (!w || !h) throw new Error('empty image');
    if (Math.max(w, h) > MAX_IMAGE_EDGE) {
      const s = MAX_IMAGE_EDGE / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    // JPEG has no alpha: paint white first so transparent PNGs don't turn black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(decoded.source, 0, 0, w, h);
    const jpeg = canvas.toDataURL('image/jpeg', 0.82);
    return { mediaType: 'image/jpeg', data: jpeg.split(',')[1] ?? '', preview: jpeg };
  } finally {
    decoded.close();
  }
}

// Minimal shape of the (vendor-prefixed) Web Speech API we use.
type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};
type SpeechResultEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
};

// Voice capability is a client-only fact that never changes during a session.
// Read it via useSyncExternalStore so it's hydration-safe (false on the server,
// real value after hydration) with NO setState inside an effect body.
const subscribeVoice = () => () => {};
function readVoiceOk(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export function Composer({
  onSend,
  disabled,
  onStop,
  suggestions = [],
  placeholder,
  lastReply,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [listening, setListening] = useState(false);
  const voiceOk = useSyncExternalStore(subscribeVoice, readVoiceOk, () => false);
  const recRef = useRef<SpeechRec | null>(null);
  const finalRef = useRef('');
  const [image, setImage] = useState<AttachedImage | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  // Always-current image, so a voice turn that ends inside a stale onResult/onEnd
  // closure (e.g. photo attached AFTER the mic started) still sends the photo.
  const imageRef = useRef(image);
  useEffect(() => {
    imageRef.current = image;
  }, [image]);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Text typed into the server-rendered box BEFORE hydration lives only in the
  // DOM; React's controlled value is still ''. Without this, the next render
  // of the composer (auth / address / suggestions landing) wrote '' back over
  // it. Adopt it once, synchronously after the hydration commit.
  useLayoutEffect(() => {
    const typed = textRef.current?.value;
    if (typed) setValue(typed);
  }, []);

  // One entry point for picked, pasted and dropped photos.
  const attachFile = async (f: File) => {
    const err = imageError(f);
    if (err) {
      setImgError(err);
      return;
    }
    setImgError(null);
    try {
      setImage(await downscaleImage(f));
    } catch {
      setImgError(
        /hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name)
          ? 'This browser can’t read HEIC photos — please attach a JPG or PNG.'
          : 'Couldn’t read that photo — try a different JPG or PNG.',
      );
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) void attachFile(f);
  };

  // Paste a screenshot / copied photo straight into the box.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith('image/'));
    if (f) {
      e.preventDefault();
      void attachFile(f);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith('image/'));
    if (f) {
      e.preventDefault();
      void attachFile(f);
    }
  };

  const submit = () => {
    const text = value.trim();
    // NOTE: no longer blocked while `disabled` (a reply streaming) — a typed
    // message is allowed through so the hook QUEUES it, exactly like tapping a
    // chip mid-stream. onSend → sendMessage enqueues when a turn is in flight.
    if (!text && !image) return;
    onSend(
      text,
      image ? { mediaType: image.mediaType, data: image.data } : undefined,
    );
    setValue('');
    setImage(null);
    setImgError(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Never submit mid-composition (Hindi / Indic / CJK IMEs use Enter to commit).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);
  const spokenRef = useRef('');

  const startListening = () => {
    if (listening) return;
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRec;
      webkitSpeechRecognition?: new () => SpeechRec;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    finalRef.current = '';
    rec.onresult = (e) => {
      let txt = '';
      let final = false;
      for (let i = 0; i < e.results.length; i++) {
        txt += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = true;
      }
      setValue(txt);
      if (final) finalRef.current = txt;
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => {
      setListening(false);
      const f = finalRef.current.trim();
      // No `disabled` check: this closure can be stale (created before a turn
      // started/ended), and the hook QUEUES a turn sent mid-stream anyway —
      // exactly like typed text — so a spoken order is never silently dropped.
      if (f) {
        // Carry the attached photo (if any) into the voice turn, then clear it
        // — otherwise a spoken order silently dropped an attached image.
        const img = imageRef.current;
        onSend(f, img ? { mediaType: img.mediaType, data: img.data } : undefined);
        setValue('');
        setImage(null);
        finalRef.current = '';
      }
    };
    recRef.current = rec;
    setValue('');
    setListening(true);
    rec.start();
  };

  const stopListening = () => recRef.current?.stop();
  const toggleMic = () => (listening ? stopListening() : startListening());

  // Hands-free: read each completed reply aloud, then re-open the mic.
  useEffect(() => {
    if (!handsFree || !lastReply || lastReply === spokenRef.current) return;
    spokenRef.current = lastReply;
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const clean = stripMarkers(lastReply)
      .replace(/[*_#`>~|]/g, '')
      .replace(/\s*\n+\s*/g, '. ')
      .trim();
    if (!clean) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = /[ऀ-ॿ]/.test(clean) ? 'hi-IN' : 'en-IN';
    u.onend = () => {
      if (handsFreeRef.current) startListening();
    };
    window.speechSynthesis.speak(u);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastReply, handsFree]);

  const toggleHandsFree = () => {
    if (handsFree) {
      setHandsFree(false);
      window.speechSynthesis?.cancel();
      stopListening();
    } else {
      spokenRef.current = lastReply ?? '';
      setHandsFree(true);
      startListening();
    }
  };

  const hasContent = value.trim().length > 0 || !!image;
  const canSend = hasContent && !disabled;

  return (
    <div
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.items).some((i) => i.type.startsWith('image/'))) {
          e.preventDefault();
        }
      }}
      onDrop={onDrop}
      className="shrink-0 border-t border-hairline bg-canvas px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-6"
    >
      {suggestions.length > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-2">
          {suggestions.map((s) => (
            // Not disabled while a reply streams: like typed text, a chip tapped
            // mid-stream is QUEUED by the hook and sent when the turn settles.
            <button
              key={s}
              type="button"
              onClick={() => onSend(s)}
              className="tap rounded-full border border-hairline bg-surface-card/50 px-3 py-1.5 text-xs text-muted transition-colors hover:border-coral hover:text-coral"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {(listening || handsFree) && (
        <div className="mb-2 flex items-center gap-2 text-xs text-coral">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-coral/60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-coral" />
          </span>
          {listening
            ? 'Listening… speak your order'
            : 'Hands-free on — I’ll read replies aloud and keep listening'}
        </div>
      )}

      {imgError && (
        <p role="alert" className="mb-2 flex items-center gap-2 text-xs text-error">
          <span>{imgError}</span>
          <button
            type="button"
            onClick={() => setImgError(null)}
            className="underline underline-offset-2 hover:text-ink"
          >
            Dismiss
          </button>
        </p>
      )}

      {image && (
        <div className="mb-2 inline-flex items-center gap-2 rounded-lg border border-hairline bg-surface-card/50 p-1.5 pr-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img decoding="async"
            src={image.preview}
            alt="Attached photo preview"
            className="h-10 w-10 rounded-md object-cover"
          />
          <span className="text-xs text-muted">
            Photo attached — I&apos;ll build your cart from it
          </span>
          <button
            type="button"
            onClick={() => setImage(null)}
            aria-label="Remove photo"
            className="rounded-full p-0.5 text-muted-soft transition-colors hover:text-ink"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className="flex items-end gap-2.5">
        <textarea
          ref={textRef}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder ?? 'Ask for anything…'}
          aria-label="Message"
          enterKeyHint="send"
          // field-sizing-content: the box grows with Shift+Enter lines up to max-h.
          className="composer-input coral-ring field-sizing-content max-h-40 min-h-[48px] min-w-0 flex-1 resize-none rounded-md border border-hairline bg-canvas px-4 py-3 text-[15px] text-ink placeholder:text-muted-soft"
        />

        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(',')}
          onChange={onFile}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          aria-label="Attach a photo"
          title="Attach a photo (JPG, PNG, WebP · max 20 MB) — or paste / drop one"
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-hairline text-muted transition-colors hover:border-coral hover:text-coral"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L7 19" />
          </svg>
        </button>

        {voiceOk && (
          <button
            type="button"
            onClick={toggleMic}
            aria-label={listening ? 'Stop listening' : 'Speak your order'}
            aria-pressed={listening}
            className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-md border transition-colors ${
              listening
                ? 'border-coral bg-coral text-on-primary'
                : 'border-hairline text-muted hover:border-coral hover:text-coral'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
            </svg>
          </button>
        )}

        {voiceOk && (
          <button
            type="button"
            onClick={toggleHandsFree}
            aria-label={handsFree ? 'Turn off hands-free' : 'Hands-free mode'}
            aria-pressed={handsFree}
            title="Hands-free — talk and I'll reply aloud"
            className={`hidden h-12 w-12 shrink-0 sm:inline-flex items-center justify-center rounded-md border transition-colors ${
              handsFree
                ? 'border-coral bg-coral text-on-primary'
                : 'border-hairline text-muted hover:border-coral hover:text-coral'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 14v-3a9 9 0 0 1 18 0v3" />
              <path d="M18 13h1a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-1Z" />
              <path d="M6 13H5a2 2 0 0 0-2 2v1a2 2 0 0 0 2 2h1Z" />
            </svg>
          </button>
        )}

        {disabled ? (
          hasContent ? (
            // A reply is streaming but you've typed something — queue it.
            <button
              type="button"
              onClick={submit}
              aria-label="Queue message"
              title="Queue — I'll send it after the current reply"
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-coral text-on-primary transition-colors hover:bg-coral-active"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </svg>
            </button>
          ) : onStop ? (
            // Streaming with an empty box — the button stops the reply.
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop"
              className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-coral text-on-primary transition-colors hover:bg-coral-active"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
                <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
              </svg>
            </button>
          ) : null
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send message"
            className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-coral text-on-primary transition-colors hover:bg-coral-active disabled:cursor-not-allowed disabled:bg-coral-disabled disabled:text-muted-soft"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

export default Composer;
