import { useEffect, useRef, useState } from 'react';

import { vscode } from '../vscodeApi.js';

type VoiceNoticeTone = 'listening' | 'idle' | 'error';

export interface VoiceDictationNotice {
  label: string;
  tone: VoiceNoticeTone;
}

interface UseVoiceDictationOptions {
  activeTerminalAgentId: number | null;
}

interface VoiceDictationState {
  isListening: boolean;
  isSupported: boolean;
  notice: VoiceDictationNotice | null;
}

const TRANSIENT_NOTICE_MS = 2600;

function getRecognitionConstructor(): SpeechRecognitionConstructorLike | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function normalizeTranscript(transcript: string): string {
  return transcript.trim().replace(/\s+/g, ' ');
}

function formatTranscriptForTyping(transcript: string): string {
  const text = normalizeTranscript(transcript);
  if (!text) return '';
  return /\s$/.test(text) ? text : `${text} `;
}

function buildInsertedText(transcript: string, before: string, after: string): string {
  let text = normalizeTranscript(transcript);
  if (!text) return '';

  const needsLeadingSpace =
    before.length > 0 && !/[\s([{/"'`-]$/.test(before) && !/^[,.;:!?)}\]]/.test(text);
  const needsTrailingSpace =
    after.length === 0
      ? !/[({[/"'`\s-]$/.test(text)
      : !/^[\s,.;:!?)}\]]/.test(after) && !/[({[/"'`\s-]$/.test(text);

  if (needsLeadingSpace) {
    text = ` ${text}`;
  }

  if (needsTrailingSpace) {
    text = `${text} `;
  }

  return text;
}

function isTextFieldElement(
  element: Element | null,
): element is HTMLInputElement | HTMLTextAreaElement {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;

  const blockedTypes = new Set([
    'button',
    'checkbox',
    'color',
    'date',
    'datetime-local',
    'file',
    'hidden',
    'image',
    'month',
    'radio',
    'range',
    'reset',
    'submit',
    'time',
    'week',
  ]);

  return !blockedTypes.has(element.type);
}

function setNativeFormControlValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  nextValue: string,
): void {
  const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(element, nextValue);
    return;
  }
  element.value = nextValue;
}

function insertIntoTextField(
  element: HTMLInputElement | HTMLTextAreaElement,
  transcript: string,
): boolean {
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;
  const before = element.value.slice(0, start);
  const after = element.value.slice(end);
  const inserted = buildInsertedText(transcript, before, after);
  if (!inserted) return false;

  setNativeFormControlValue(element, `${before}${inserted}${after}`);
  const nextCursor = before.length + inserted.length;
  element.setSelectionRange(nextCursor, nextCursor);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

function insertIntoContentEditable(element: HTMLElement, transcript: string): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  if (!element.contains(selection.anchorNode)) return false;

  const text = formatTranscriptForTyping(transcript);
  if (!text) return false;

  document.execCommand('insertText', false, text);
  return true;
}

function isXtermInput(element: Element | null): element is HTMLTextAreaElement {
  return (
    !!element &&
    element instanceof HTMLTextAreaElement &&
    element.classList.contains('xterm-helper-textarea')
  );
}

function tryInsertIntoWebviewTarget(
  transcript: string,
  activeTerminalAgentId: number | null,
): boolean {
  const activeElement = document.activeElement;

  if (isTextFieldElement(activeElement)) {
    return insertIntoTextField(activeElement, transcript);
  }

  if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
    return insertIntoContentEditable(activeElement, transcript);
  }

  if (isXtermInput(activeElement) && activeTerminalAgentId !== null) {
    const text = formatTranscriptForTyping(transcript);
    if (!text) return false;
    vscode.postMessage({
      type: 'terminalInput',
      agentId: activeTerminalAgentId,
      data: text,
    });
    return true;
  }

  return false;
}

function extractFinalTranscript(event: SpeechRecognitionEventLike): string {
  const chunks: string[] = [];
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    if (!result?.isFinal) continue;
    const alternative = result[0] ?? result.item(0);
    const transcript = alternative?.transcript ?? '';
    if (transcript.trim()) {
      chunks.push(transcript);
    }
  }
  return chunks.join(' ');
}

function describeRecognitionError(error: string): string {
  if (error === 'audio-capture') return 'Microphone not available';
  if (error === 'network') return 'Speech service unavailable';
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    return 'Microphone permission blocked';
  }
  if (error === 'no-speech') return 'No speech detected';
  return 'Voice dictation stopped';
}

export function useVoiceDictation({
  activeTerminalAgentId,
}: UseVoiceDictationOptions): VoiceDictationState {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [notice, setNotice] = useState<VoiceDictationNotice | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const keepListeningRef = useRef(false);
  const noticeTimerRef = useRef<number | null>(null);
  const terminalAgentIdRef = useRef(activeTerminalAgentId);

  useEffect(() => {
    terminalAgentIdRef.current = activeTerminalAgentId;
  }, [activeTerminalAgentId]);

  useEffect(() => {
    const clearNoticeTimer = () => {
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
    };

    const showTransientNotice = (nextNotice: VoiceDictationNotice) => {
      clearNoticeTimer();
      setNotice(nextNotice);
      noticeTimerRef.current = window.setTimeout(() => {
        setNotice((current) =>
          current?.label === nextNotice.label && current.tone !== 'listening' ? null : current,
        );
        noticeTimerRef.current = null;
      }, TRANSIENT_NOTICE_MS);
    };

    const showListeningNotice = () => {
      clearNoticeTimer();
      setNotice({ label: 'Voice listening', tone: 'listening' });
    };

    const toggleListening = () => {
      const recognition = recognitionRef.current;
      if (!recognition) {
        showTransientNotice({
          label: 'Speech recognition unavailable in this VS Code build',
          tone: 'error',
        });
        return;
      }

      if (keepListeningRef.current) {
        keepListeningRef.current = false;
        recognition.stop();
        return;
      }

      keepListeningRef.current = true;
      try {
        recognition.start();
      } catch (error) {
        keepListeningRef.current = false;
        console.error('[Pixel Agents] Voice dictation start failed:', error);
        showTransientNotice({
          label: 'Could not start voice dictation',
          tone: 'error',
        });
      }
    };

    const recognitionCtor = getRecognitionConstructor();
    setIsSupported(!!recognitionCtor);

    if (recognitionCtor) {
      const recognition = new recognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = navigator.language || 'en-US';
      recognition.maxAlternatives = 1;

      recognition.addEventListener('start', () => {
        setIsListening(true);
        showListeningNotice();
      });

      recognition.addEventListener('result', (event) => {
        const transcript = extractFinalTranscript(event as SpeechRecognitionEventLike);
        if (!transcript) return;

        if (tryInsertIntoWebviewTarget(transcript, terminalAgentIdRef.current)) {
          showListeningNotice();
          return;
        }

        const text = formatTranscriptForTyping(transcript);
        if (!text) return;
        vscode.postMessage({ type: 'voiceDictationTypeText', text });
        showListeningNotice();
      });

      recognition.addEventListener('error', (event) => {
        const details = event as SpeechRecognitionErrorEventLike;
        const isManualAbort = details.error === 'aborted' && !keepListeningRef.current;
        if (isManualAbort) {
          return;
        }

        keepListeningRef.current = false;
        setIsListening(false);
        showTransientNotice({
          label: describeRecognitionError(details.error),
          tone: 'error',
        });
      });

      recognition.addEventListener('end', () => {
        if (keepListeningRef.current) {
          try {
            recognition.start();
            return;
          } catch (error) {
            keepListeningRef.current = false;
            console.error('[Pixel Agents] Voice dictation restart failed:', error);
            showTransientNotice({
              label: 'Voice dictation stopped unexpectedly',
              tone: 'error',
            });
          }
        }

        setIsListening(false);
        showTransientNotice({ label: 'Voice off', tone: 'idle' });
      });

      recognitionRef.current = recognition;
    }

    const messageHandler = (event: MessageEvent) => {
      if (event.data?.type === 'toggleVoiceDictation') {
        toggleListening();
      }
    };

    window.addEventListener('message', messageHandler);

    return () => {
      keepListeningRef.current = false;
      window.removeEventListener('message', messageHandler);
      clearNoticeTimer();
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  return {
    isListening,
    isSupported,
    notice,
  };
}
